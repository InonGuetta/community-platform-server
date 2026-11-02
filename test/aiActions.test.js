import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "fs/promises";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { llmQueue } from "../queue/llmQueue.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { requestAiAction, runAiAction, AI_ACTIONS, AI_ACTION_STALE_MINUTES } from "../services/transcripts/aiActions.js";
import { badRequest } from "../lib/AppError.js";

// "תיקון עברית" and "כותרות משנה" as queued work (PRD PIPE-5): the request
// claims and queues, the worker runs and records. Redis is replaced by a stub
// on llmQueue.add; the database by the usual pool stub.

after(async () => {
  await Promise.all([transcriptionQueue.close(), llmQueue.close()]);
});

const originalAdd = llmQueue.add.bind(llmQueue);
const withQueue = async (add, fn) => {
  llmQueue.add = add;
  try {
    return await fn();
  } finally {
    llmQueue.add = originalAdd;
  }
};

const db = ({ hasText = true, claimed = true } = {}) =>
  stubPoolQuery(pool, (text) => {
    if (/AS has_text|AS has_chunks/.test(text)) return { rows: [{ has_text: hasText, has_chunks: hasText }] };
    if (/SET hebrew_fix_status = 'queued'|SET headings_status = 'queued'/.test(text)) {
      return { rows: claimed ? [{ media_id: 9, hebrew_fix_status: "queued", headings_status: "queued" }] : [] };
    }
    return { rows: [] };
  });

test("a request claims the action and queues one job, by name", async () => {
  const stub = db();
  const added = [];
  try {
    const row = await withQueue(async (...args) => { added.push(args); return { id: 1 }; }, () => requestAiAction(9, "hebrewFix"));
    assert.equal(row.hebrew_fix_status, "queued");
    assert.deepEqual(added, [["hebrew-fix", { mediaId: 9 }, { attempts: 1 }]]);
    const claim = stub.calls.find((c) => /SET hebrew_fix_status = 'queued'/.test(c.text));
    assert.match(claim.text, /hebrew_fix_status NOT IN \('queued', 'running'\)/, "not while queued or running");
    assert.match(claim.text, new RegExp(`INTERVAL '${AI_ACTION_STALE_MINUTES} minutes'`), "unless the claim is stale");
  } finally {
    stub.restore();
  }
});

test("a second press while it runs is a 409, and nothing is queued", async () => {
  const stub = db({ claimed: false });
  let queued = false;
  try {
    const err = await withQueue(async () => { queued = true; }, () => requestAiAction(9, "headings")).catch((e) => e);
    assert.equal(err.statusCode, 409);
    assert.equal(err.code, "ALREADY_QUEUED");
    assert.equal(queued, false);
  } finally {
    stub.restore();
  }
});

test("nothing to work on is refused at once — before any claim", async () => {
  const stub = db({ hasText: false });
  try {
    const err = await withQueue(async () => ({}), () => requestAiAction(9, "hebrewFix")).catch((e) => e);
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, "NO_TRANSCRIPT_TEXT");
    assert.equal(stub.calls.some((c) => /_status = 'queued'/.test(c.text)), false);
  } finally {
    stub.restore();
  }
});

// Otherwise the button says "already running" about work that never started.
test("a queue that refuses the job releases the claim and answers 503", async () => {
  const stub = db();
  try {
    const err = await withQueue(async () => { throw new Error("connection refused"); }, () => requestAiAction(9, "hebrewFix")).catch((e) => e);
    assert.equal(err.statusCode, 503);
    assert.ok(stub.calls.some((c) => /SET hebrew_fix_status = NULL/.test(c.text)), "the claim was released");
  } finally {
    stub.restore();
  }
});

test("the worker records running, then done", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  // AI_ACTIONS is frozen one level deep; each action's own object is not, so
  // its work can be replaced here and put back.
  const original = AI_ACTIONS.headings.run;
  AI_ACTIONS.headings.run = async () => {};
  try {
    await runAiAction(9, "headings");
    const statuses = stub.calls.map((c) => c.text.match(/headings_status = '(\w+)'/)?.[1]).filter(Boolean);
    assert.deepEqual(statuses, ["running", "done"]);
  } finally {
    AI_ACTIONS.headings.run = original;
    stub.restore();
  }
});

test("a failure records 'error' with the AppError's code, and rethrows", async () => {
  const stub = stubPoolQuery(pool, (text) => {
    // The Hebrew correction's own first read: no transcript row.
    if (/SELECT edited_text FROM transcripts/.test(text)) return { rows: [] };
    return { rows: [] };
  });
  try {
    const err = await runAiAction(9, "hebrewFix").catch((e) => e);
    assert.equal(err.statusCode, 404);
    const record = stub.calls.find((c) => /SET hebrew_fix_status = 'error'/.test(c.text));
    assert.deepEqual(record.params, [9, "TRANSCRIPT_NOT_FOUND"]);
  } finally {
    stub.restore();
  }
});

test("a failure that is not the user's records no message", async () => {
  const stub = stubPoolQuery(pool, (text) => {
    if (/SELECT edited_text FROM transcripts/.test(text)) throw new Error("socket hang up");
    return { rows: [] };
  });
  try {
    await runAiAction(9, "hebrewFix").catch(() => {});
    const record = stub.calls.find((c) => /SET hebrew_fix_status = 'error'/.test(c.text));
    assert.deepEqual(record.params, [9, null]);
  } finally {
    stub.restore();
  }
  assert.ok(badRequest("x").expose, "AppError is the one kind whose code is stored");
});

// Bull leaves a named job with no matching processor waiting for ever, so the
// worker must register one for every action — checked on its source, because
// running it needs Redis.
test("the LLM worker has a processor for every action's job name", async () => {
  const source = await readFile(new URL("../queue/workers/llmWorker.js", import.meta.url), "utf8");
  assert.match(source, /for \(const \[name, action\] of Object\.entries\(AI_ACTIONS\)\)/);
  assert.match(source, /llmQueue\.process\(action\.jobName,/);
  assert.match(source, /runAiAction\(mediaId,/);
  assert.deepEqual(Object.values(AI_ACTIONS).map((a) => a.jobName).sort(), ["hebrew-fix", "key-point-headings"]);
});
