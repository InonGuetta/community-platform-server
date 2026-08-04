import test from "node:test";
import assert from "node:assert/strict";
import { chunkTextByParagraph, TEXT_CHUNK_WORDS } from "../lib/textChunks.js";

// The chunker decides what a search hit points at and what each embedding
// represents, so its failures are the quiet kind: a chunk cut through the middle
// of an argument still looks fine in the database and simply makes search worse.
//
// char_start/char_end are the document's only position anchor, and everything
// built on top of them later depends on them being exact — so they are asserted
// against the source string itself rather than against expected numbers.

const paragraphs = (count, wordsEach, prefix = "מילה") =>
  Array.from({ length: count }, (_, p) =>
    Array.from({ length: wordsEach }, (_, w) => `${prefix}${p}_${w}`).join(" ")
  ).join("\n\n");

test("returns nothing for empty or whitespace-only input", () => {
  assert.deepEqual(chunkTextByParagraph(""), []);
  assert.deepEqual(chunkTextByParagraph("   \n\n  \n "), []);
  assert.deepEqual(chunkTextByParagraph(null), []);
});

test("a short document is a single chunk", () => {
  const text = paragraphs(2, 10);
  const chunks = chunkTextByParagraph(text);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].chunk_index, 0);
});

test("char offsets point at exactly the chunk's own content", () => {
  const text = paragraphs(12, 120);
  const chunks = chunkTextByParagraph(text);
  assert.ok(chunks.length > 1, "this input must actually split");
  for (const chunk of chunks) {
    assert.equal(
      text.slice(chunk.char_start, chunk.char_end),
      chunk.content,
      `chunk ${chunk.chunk_index} offsets must reproduce its content`
    );
  }
});

test("chunks are ordered, non-overlapping and indexed from zero", () => {
  const chunks = chunkTextByParagraph(paragraphs(20, 100));
  chunks.forEach((chunk, i) => {
    assert.equal(chunk.chunk_index, i);
    assert.ok(chunk.char_end > chunk.char_start, "a chunk must not be empty");
    if (i > 0) {
      assert.ok(
        chunk.char_start >= chunks[i - 1].char_end,
        `chunk ${i} must start at or after chunk ${i - 1} ends`
      );
    }
  });
});

test("no content is lost — every word survives somewhere", () => {
  const text = paragraphs(15, 90);
  const chunks = chunkTextByParagraph(text);
  const rejoined = chunks.map((c) => c.content).join(" ").split(/\s+/).sort();
  const original = text.split(/\s+/).filter(Boolean).sort();
  assert.deepEqual(rejoined, original);
});

test("splits on paragraph boundaries rather than mid-paragraph", () => {
  // 8 paragraphs of 120 words: several fit per chunk, none needs breaking.
  const chunks = chunkTextByParagraph(paragraphs(8, 120));
  for (const chunk of chunks) {
    assert.ok(
      /^מילה\d+_0\b/.test(chunk.content.trim()),
      `chunk should start at a paragraph's first word, got: ${chunk.content.slice(0, 30)}`
    );
  }
});

test("breaks up a single paragraph that is far too large to be one chunk", () => {
  // One unbroken 3,000-word block — the case that would otherwise produce a
  // chunk too coarse to search and too large to embed well.
  const text = Array.from({ length: 3000 }, (_, i) => `מילה${i}`).join(" ");
  const chunks = chunkTextByParagraph(text);
  assert.ok(chunks.length >= 6, `expected the block to be split, got ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(
      chunk.content.split(/\s+/).length <= TEXT_CHUNK_WORDS,
      "a split piece must not exceed the target size"
    );
  }
});

test("respects the target size for normal prose", () => {
  const chunks = chunkTextByParagraph(paragraphs(30, 80));
  for (const chunk of chunks.slice(0, -1)) {
    const words = chunk.content.split(/\s+/).length;
    assert.ok(
      words <= TEXT_CHUNK_WORDS * 1.5,
      `chunk of ${words} words overshoots the ${TEXT_CHUNK_WORDS}-word target`
    );
  }
});

test("keeps the blank line between paragraphs grouped into one chunk", () => {
  const chunks = chunkTextByParagraph(paragraphs(4, 50));
  assert.equal(chunks.length, 1, "200 words should stay in one chunk");
  assert.ok(chunks[0].content.includes("\n\n"), "paragraph structure must survive");
});

test("a custom target size is honoured", () => {
  const chunks = chunkTextByParagraph(paragraphs(10, 50), 100);
  assert.ok(chunks.length >= 4, `expected ~5 chunks at 100 words, got ${chunks.length}`);
});

test("leading and trailing whitespace never lands inside a chunk", () => {
  const chunks = chunkTextByParagraph(`\n\n   ${paragraphs(6, 100)}   \n\n`);
  for (const chunk of chunks) {
    assert.equal(chunk.content, chunk.content.trim(), "chunk content must be tight");
  }
});
