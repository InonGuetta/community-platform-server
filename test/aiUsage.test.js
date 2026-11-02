import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "fs/promises";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { meterOpenAI } from "../lib/openaiClient.js";
import { costOf, recordAiUsage, assertWithinAiBudget, PRICES } from "../services/servicesAiUsage.js";
import { triggerPipeline } from "../services/transcripts/pipeline.js";
import { llmQueue } from "../queue/llmQueue.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";

// The OpenAI cost meter (PRD ADM-1) and the monthly cap (NFR-3).

after(async () => {
  await Promise.all([transcriptionQueue.close(), llmQueue.close()]);
});

// ── The arithmetic ──────────────────────────────────────────────────────────

test("a text call costs its tokens at the model's price per million", () => {
  // gpt-4o: $2.50 in, $10 out, per 1M tokens.
  assert.equal(costOf({ model: "gpt-4o", inputTokens: 1_000_000, outputTokens: 0 }), 2.5);
  assert.equal(costOf({ model: "gpt-4o", inputTokens: 2000, outputTokens: 500 }), 0.01);
  // A dated snapshot is billed as its family.
  assert.equal(costOf({ model: "gpt-4o-2024-08-06", inputTokens: 1_000_000 }), 2.5);
  assert.equal(costOf({ model: "gpt-4o-mini", inputTokens: 1_000_000 }), PRICES["gpt-4o-mini"].input);
});

test("Whisper costs its minutes of audio", () => {
  assert.equal(costOf({ model: "whisper-1", audioSeconds: 600 }), 0.06);
});

test("a model with no price is recorded at nothing rather than guessed", () => {
  assert.equal(costOf({ model: "some-new-model", inputTokens: 5000 }), 0);
});

test("recording never throws — the call it describes already happened", async () => {
  const stub = stubPoolQuery(pool, () => { throw new Error("db down"); });
  try {
    await assert.doesNotReject(() => recordAiUsage({ purpose: "chat", model: "gpt-4o", inputTokens: 10 }));
  } finally {
    stub.restore();
  }
});

// ── The meter ───────────────────────────────────────────────────────────────

const recorder = () => {
  const seen = [];
  return { seen, record: async (usage) => { seen.push(usage); } };
};

test("a completion is recorded with what it was for and the tokens OpenAI reported", async () => {
  const { seen, record } = recorder();
  const client = { chat: { completions: { create: async () => ({ model: "gpt-4o-2024-08-06", usage: { prompt_tokens: 120, completion_tokens: 30 }, choices: [] }) } } };
  const metered = meterOpenAI(client, "hebrew_fix", record);
  const response = await metered.chat.completions.create({ model: "gpt-4o", messages: [] });
  assert.equal(response.usage.prompt_tokens, 120, "the response comes back unchanged");
  assert.deepEqual(seen, [{ purpose: "hebrew_fix", model: "gpt-4o-2024-08-06", inputTokens: 120, outputTokens: 30 }]);
});

// A streamed answer reports usage only in a final chunk, and only when asked.
test("a stream asks for its usage, passes every chunk through, and records at the end", async () => {
  const { seen, record } = recorder();
  let sentParams;
  const chunks = [
    { choices: [{ delta: { content: "שלום" } }] },
    { choices: [{ delta: { content: " עולם" } }] },
    { choices: [], usage: { prompt_tokens: 900, completion_tokens: 40 }, model: "gpt-4o" },
  ];
  const client = {
    chat: { completions: { create: async (params) => {
      sentParams = params;
      return (async function* () { yield* chunks; })();
    } } },
  };
  const stream = await meterOpenAI(client, "chat", record).chat.completions.create({ model: "gpt-4o", stream: true, messages: [] });
  const got = [];
  for await (const chunk of stream) got.push(chunk);
  assert.equal(sentParams.stream_options.include_usage, true);
  assert.deepEqual(got, chunks);
  assert.deepEqual(seen, [{ purpose: "chat", model: "gpt-4o", inputTokens: 900, outputTokens: 40 }]);
});

test("a stream cut short records nothing rather than a guess", async () => {
  const { seen, record } = recorder();
  const client = { chat: { completions: { create: async () => (async function* () { yield { choices: [{ delta: { content: "א" } }] }; })() } } };
  const stream = await meterOpenAI(client, "chat", record).chat.completions.create({ model: "gpt-4o", stream: true, messages: [] });
  for await (const chunk of stream) { void chunk; break; }
  assert.deepEqual(seen, []);
});

test("embeddings and Whisper are recorded by tokens and by seconds", async () => {
  const { seen, record } = recorder();
  const client = {
    embeddings: { create: async () => ({ model: "text-embedding-3-small", usage: { prompt_tokens: 800, total_tokens: 800 }, data: [] }) },
    audio: { transcriptions: { create: async () => ({ duration: 598.4, segments: [] }) } },
  };
  await meterOpenAI(client, "embeddings", record).embeddings.create({ model: "text-embedding-3-small", input: ["x"] });
  await meterOpenAI(client, "transcription", record).audio.transcriptions.create({ model: "whisper-1", file: null });
  assert.deepEqual(seen, [
    { purpose: "embeddings", model: "text-embedding-3-small", inputTokens: 800 },
    { purpose: "transcription", model: "whisper-1", audioSeconds: 598.4 },
  ]);
});

// The meter is only as complete as its coverage: a module that calls a bare
// client would spend without being counted.
test("every module that calls OpenAI calls it through the meter", async () => {
  const files = [
    "services/transcripts/analysis.js", "services/transcripts/hebrew.js", "services/transcripts/headings.js",
    "services/transcripts/search.js", "services/discussion/chat.js", "services/servicesEmbeddings.js",
    "queue/workers/transcriptionWorker.js",
  ];
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /meterOpenAI\(/, `${file} calls OpenAI without the meter`);
  }
});

// ── The cap ─────────────────────────────────────────────────────────────────

const withCap = async (cap, fn) => {
  const saved = process.env.AI_MONTHLY_CAP_USD;
  if (cap === undefined) delete process.env.AI_MONTHLY_CAP_USD;
  else process.env.AI_MONTHLY_CAP_USD = String(cap);
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.AI_MONTHLY_CAP_USD;
    else process.env.AI_MONTHLY_CAP_USD = saved;
  }
};

test("with no cap set, nothing is refused and the database is not asked", async () => {
  const stub = stubPoolQuery(pool, () => { throw new Error("asked"); });
  try {
    await withCap(undefined, () => assertWithinAiBudget());
    await withCap("", () => assertWithinAiBudget());
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("once the month's spend reaches the cap, new work is refused with its own code", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [{ spent: 50.01 }] }));
  try {
    const err = await withCap(50, () => assertWithinAiBudget()).catch((e) => e);
    assert.equal(err.statusCode, 429);
    assert.equal(err.code, "AI_BUDGET_EXCEEDED");
    // The month is Israel's month.
    assert.match(stub.calls[0].text, /date_trunc\('month', NOW\(\) AT TIME ZONE 'Asia\/Jerusalem'\)/);
  } finally {
    stub.restore();
  }
});

test("under the cap, nothing is refused", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [{ spent: 12.5 }] }));
  try {
    await withCap(50, () => assertWithinAiBudget());
  } finally {
    stub.restore();
  }
});

test("a new transcription is refused over the cap, before anything is written", async () => {
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM media_items WHERE id=\$1/.test(text)) return { rows: [{ id: 3, s3_key: "local/x.mp3", media_type: "audio" }] };
    if (/FROM ai_usage/.test(text)) return { rows: [{ spent: 80 }] };
    if (/INSERT INTO transcripts/.test(text)) throw new Error("a row was written");
    return { rows: [] };
  });
  try {
    const err = await withCap(50, () => triggerPipeline(3)).catch((e) => e);
    assert.equal(err.code, "AI_BUDGET_EXCEEDED");
  } finally {
    stub.restore();
  }
});

// The chat is deliberately not capped here — it has its own daily quota.
test("the chat does not check the monthly cap", async () => {
  const source = await readFile(new URL("../services/discussion/chat.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /assertWithinAiBudget/);
});
