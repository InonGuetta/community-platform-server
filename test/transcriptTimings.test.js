import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { stubPoolConnect, stubPoolQuery } from "./setup.js";
import {
  timingAnchors,
  saveChunks,
  saveTextChunks,
  getTranscriptByMediaId,
} from "../services/transcripts/chunks.js";

// When each word of a recording was said (PRD MOB-5, MOB-6, migration 041):
// what the worker keeps of Whisper's timings, and what the transcript read
// hands the client for captions and the scrolling transcript.

const speech = (text, start, end) => ({ text, start, end });

test("one anchor per phrase — the word it starts at and when — and one for the end", () => {
  const anchors = timingAnchors([
    speech("שלום עולם", 0, 2.04),
    speech("מה שלומך היום", 2.04, 5.47),
    speech("טוב", 6.1, 7),
  ]);
  assert.deepEqual(anchors, [[0, 0], [2, 2], [5, 6.1], [6, 7]]);
});

// The same rule the chunks use, so word N here is word N of the chunk text.
test("a silent phrase adds neither words nor a moment", () => {
  const anchors = timingAnchors([speech("א ב", 0, 1), speech("   ", 1, 30), speech("ג", 30, 31)]);
  assert.deepEqual(anchors, [[0, 0], [2, 30], [3, 31]]);
});

test("a phrase reported out of order keeps its words but cannot make time run backwards", () => {
  const anchors = timingAnchors([speech("א ב", 10, 12), speech("ג", 5, 6), speech("ד", 13, 14)]);
  assert.deepEqual(anchors, [[0, 10], [3, 13], [4, 14]]);
  for (let i = 1; i < anchors.length; i += 1) assert.ok(anchors[i][1] >= anchors[i - 1][1]);
});

test("no speech, no anchors", () => {
  assert.deepEqual(timingAnchors([]), []);
  assert.deepEqual(timingAnchors([speech("", 0, 600)]), []);
});

test("a recording's timings are written in the same transaction as its chunks", async () => {
  const stub = stubPoolConnect(pool, () => ({ rows: [] }));
  try {
    await saveChunks(7, [speech("שלום עולם", 0, 2), speech("מה שלומך", 2, 4)]);
  } finally {
    stub.restore();
  }
  const texts = stub.calls.map((c) => c.text.trim().split(/\s+/).slice(0, 3).join(" "));
  const begin = texts.indexOf("BEGIN");
  const timings = stub.calls.findIndex((c) => /INSERT INTO transcript_timings/.test(c.text));
  const commit = texts.indexOf("COMMIT");
  assert.ok(begin >= 0 && timings > begin && commit > timings, `order was: ${texts.join(" | ")}`);

  const { params, text } = stub.calls[timings];
  assert.match(text, /ON CONFLICT \(media_id\) DO UPDATE/);
  assert.equal(params[0], 7);
  assert.deepEqual(JSON.parse(params[1]), [[0, 0], [2, 2], [4, 4]]);
});

test("a document has no timings to write", async () => {
  const stub = stubPoolConnect(pool, () => ({ rows: [] }));
  try {
    await saveTextChunks(7, "פסקה אחת.\n\nפסקה שנייה.");
  } finally {
    stub.restore();
  }
  assert.equal(stub.calls.some((c) => /transcript_timings/.test(c.text)), false);
});

// ── Reading them back ───────────────────────────────────────────────────────

const VISIBLE = { is_published: true, course_id: null, uploader_id: 1 };
const reader = (anchors) => (text) => {
  if (/FROM media_items/.test(text)) return { rows: [VISIBLE] };
  if (/FROM transcripts/.test(text)) return { rows: [{ media_id: 7, status: "done" }] };
  if (/FROM transcript_chunks/.test(text)) return { rows: [{ id: 1, chunk_index: 0, start_time: 0, end_time: 4, content: "x" }] };
  if (/FROM transcript_timings/.test(text)) return { rows: anchors ? [{ anchors }] : [] };
  return { rows: [] };
};

test("the transcript carries its timings", async () => {
  const stub = stubPoolQuery(pool, reader([[0, 0], [1, 4]]));
  try {
    const transcript = await getTranscriptByMediaId(7);
    assert.deepEqual(transcript.timing, [[0, 0], [1, 4]]);
  } finally {
    stub.restore();
  }
});

// Transcribed before migration 041 — the client estimates from the chunks.
test("a lesson with no stored timings says so with null", async () => {
  const stub = stubPoolQuery(pool, reader(null));
  try {
    assert.equal((await getTranscriptByMediaId(7)).timing, null);
  } finally {
    stub.restore();
  }
});

// A book's page asks for the chunks without their text; timings position text,
// so they are not even looked up.
test("not asked for without the text", async () => {
  const stub = stubPoolQuery(pool, reader([[0, 0]]));
  try {
    const transcript = await getTranscriptByMediaId(7, undefined, { content: false });
    assert.equal(transcript.timing, null);
    assert.equal(stub.calls.some((c) => /transcript_timings/.test(c.text)), false);
  } finally {
    stub.restore();
  }
});
