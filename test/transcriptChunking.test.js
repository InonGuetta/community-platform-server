import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { stubPoolConnect } from "./setup.js";
import { saveChunks, CHUNK_WORDS } from "../services/transcripts/chunks.js";

// Driven through saveChunks rather than the splitter directly: the splitter is
// internal, and what actually matters is the rows that reach the INSERT — the
// content that gets embedded and the times a search result points at.

// The multi-row INSERT lays out one parameter per column per chunk, in the order
// the column list declares them.
//
// The stride is READ FROM THE STATEMENT rather than written here as a number.
// It used to be a literal 7, and adding page_number in migration 023 made it 8 —
// at which point this decoder silently re-cut every row at the wrong boundary
// and reported two chunks where there was one. The failure looked like a
// chunking bug, which is the most expensive kind of wrong: the test pointed away
// from the change that broke it. Counting the placeholders in the first value
// group means the next column costs nothing here.
const strideOf = (sql) => {
  const firstGroup = sql.match(/\(([^)]*)\)\s*(?:,|$)/);
  const count = firstGroup ? (firstGroup[1].match(/\$\d+/g) || []).length : 0;
  if (count === 0) throw new Error("could not read the parameter stride from the INSERT");
  return count;
};

const chunksFrom = (calls) => {
  const insert = calls.find((c) => /INSERT INTO transcript_chunks/i.test(c.text));
  if (!insert) return [];
  const stride = strideOf(insert.text.split("VALUES")[1] ?? "");
  const rows = [];
  for (let i = 0; i < insert.params.length; i += stride) {
    const [, chunk_index, start_time, end_time, content] = insert.params.slice(i, i + stride);
    rows.push({ chunk_index, start_time, end_time, content });
  }
  return rows;
};

const capture = async (segments) => {
  const stub = stubPoolConnect(pool, () => ({ rows: [] }));
  try {
    await saveChunks(1, segments);
    return chunksFrom(stub.calls);
  } finally {
    stub.restore();
  }
};

const speech = (text, start, end) => ({ text, start, end });

test("a chunk's content is the words that were spoken", async () => {
  const [chunk] = await capture([speech("שלום עולם", 0, 2), speech("מה שלומך", 2, 4)]);
  assert.equal(chunk.content, "שלום עולם מה שלומך");
  assert.equal(chunk.start_time, 0);
  assert.equal(chunk.end_time, 4);
});

// "".split(/\s+/) is [""] — one empty string, which counts as a word. Whisper
// does emit silent segments, so every one of them was adding a phantom word to
// the total and an extra space to the joined text.
test("a silent segment adds no words and no spaces", async () => {
  const [chunk] = await capture([
    speech("ראשון", 0, 1),
    speech("", 1, 2),
    speech("   ", 2, 3),
    speech("שני", 3, 4),
  ]);
  assert.equal(chunk.content, "ראשון שני", "no doubled spaces from the empty segments");
});

// The phantom words counted towards CHUNK_WORDS, so chunks closed early — by
// however many silences they happened to contain.
test("silence does not push a chunk over its word limit", async () => {
  const segments = [];
  for (let i = 0; i < CHUNK_WORDS - 1; i++) {
    segments.push(speech(`מילה${i}`, i, i + 1));
    segments.push(speech("", i, i + 1)); // as many silences as words
  }
  const chunks = await capture(segments);
  assert.equal(chunks.length, 1, "one chunk short of the limit must not have been split");
});

test("the limit itself still closes a chunk", async () => {
  const segments = Array.from({ length: CHUNK_WORDS + 1 }, (_, i) => speech(`מילה${i}`, i, i + 1));
  const chunks = await capture(segments);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].content.split(" ").length, CHUNK_WORDS);
});

// A chunk's start_time is what a search hit jumps to. Taking it from a silent
// segment would point the listener at a moment where nothing is said.
test("a chunk starts at the first words in it, not at a preceding silence", async () => {
  const [chunk] = await capture([
    speech("", 0, 30),          // half a minute of nothing
    speech("כאן מתחיל", 30, 32),
  ]);
  assert.equal(chunk.start_time, 30);
});

test("a chunk does not end after the last thing said in it", async () => {
  const [chunk] = await capture([
    speech("סוף הדברים", 10, 12),
    speech("", 12, 90),         // trailing silence
  ]);
  assert.equal(chunk.end_time, 12);
});

test("a transcript of pure silence produces nothing at all", async () => {
  assert.deepEqual(await capture([speech("", 0, 5), speech("  ", 5, 10)]), []);
});

test("a segment with no text field does not crash the write", async () => {
  const [chunk] = await capture([{ start: 0, end: 1 }, speech("אחרי", 1, 2)]);
  assert.equal(chunk.content, "אחרי");
});
