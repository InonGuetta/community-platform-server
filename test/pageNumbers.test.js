import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { cleanExtractedText, PAGE_SEPARATOR, joinPagesWithOffsets } from "../lib/textExtract.js";
import { pageNumberFor, pagesForStoredChunks } from "../services/transcripts/chunks.js";

// Citing a chunk by page.
//
// The first version of this computed page offsets from the page LENGTHS, after
// joining and re-cleaning. That is wrong in the way that is hardest to notice:
// an empty page — a blank leaf in a PDF, which is common — makes the join
// contain a run of newlines that the cleaning pass collapses, so the string
// loses characters the arithmetic still counts and every page label after the
// first blank leaf is off by a growing amount. Confidently wrong, which for a
// citation is worse than absent.
//
// The text and the offsets are therefore built together, and the first group
// below is that property under test rather than in a comment.

// ── The offsets describe the string that is actually stored ─────────────────

// Whatever joinPagesWithOffsets says about where a page starts must be true OF
// ITS OWN OUTPUT. Everything else here rests on this.
const assertOffsetsDescribe = (cleaned) => {
  const { text, pageOffsets } = joinPagesWithOffsets(cleaned);
  cleaned.forEach((page, i) => {
    if (!page) return; // an empty page has no characters to find
    assert.equal(
      text.slice(pageOffsets[i], pageOffsets[i] + page.length),
      page,
      `page ${i + 1} is not where the offsets say it is`
    );
  });
  return { text, pageOffsets };
};

test("every page is found exactly where its offset says", () => {
  const cleaned = [
    "  שורה ראשונה  \n\n\n  שורה שנייה\n42\n",
    "עמוד שני\r\nעם CRLF\n\n\n\nוריווח",
    "  \n עמוד שלישי \n  ",
  ].map(cleanExtractedText);
  assertOffsetsDescribe(cleaned);
});

// The case that broke the first attempt.
test("a blank page does not shift every page after it", () => {
  const cleaned = ["עמוד ראשון", "", "עמוד שלישי", "", "", "עמוד שישי"].map(cleanExtractedText);
  const { text, pageOffsets } = assertOffsetsDescribe(cleaned);

  // Numbering survives the blanks: the sixth page is still the sixth.
  assert.equal(pageOffsets.length, 6);
  assert.equal(text.slice(pageOffsets[5]), "עמוד שישי");

  // And the blanks contribute nothing to the text itself, so it needs no
  // further cleaning — which is what removes the fragile assumption entirely.
  assert.doesNotMatch(text, /\n{3,}/);
  assert.equal(text, cleanExtractedText(text));
});

test("a document that is entirely blank pages produces empty text, not a crash", () => {
  const { text, pageOffsets } = joinPagesWithOffsets(["", "", ""]);
  assert.equal(text, "");
  assert.equal(pageOffsets.length, 3);
});

test("the separator is the paragraph break the chunker splits on", () => {
  // A page boundary is therefore always a candidate chunk boundary, and never
  // lands mid-sentence.
  assert.equal(PAGE_SEPARATOR, "\n\n");
});

// ── Mapping an offset to a page ─────────────────────────────────────────────

// Three pages of 100, 50 and 200 characters, joined by two newlines each.
const OFFSETS = [0, 102, 154];

test("an offset inside a page gets that page", () => {
  assert.equal(pageNumberFor(OFFSETS, 50), 1);
  assert.equal(pageNumberFor(OFFSETS, 120), 2);
  assert.equal(pageNumberFor(OFFSETS, 300), 3);
});

// Pages are 1-based for a reader. Offset 0 is page one, not page zero.
test("the first character is page 1", () => {
  assert.equal(pageNumberFor(OFFSETS, 0), 1);
});

test("an offset exactly on a boundary belongs to the page that starts there", () => {
  assert.equal(pageNumberFor(OFFSETS, 101), 1);
  assert.equal(pageNumberFor(OFFSETS, 102), 2);
  assert.equal(pageNumberFor(OFFSETS, 153), 2);
  assert.equal(pageNumberFor(OFFSETS, 154), 3);
});

// Every format that has no pages, and every PDF whose boundaries could not be
// derived. NULL is the truth; a fake page 1 would make the citation meaningless
// exactly where it is supposed to be useful.
test("no offsets means no page number, not page 1", () => {
  assert.equal(pageNumberFor(null, 500), null);
  assert.equal(pageNumberFor([], 500), null);
  assert.equal(pageNumberFor(undefined, 500), null);
});

test("a single-page document reports page 1 throughout", () => {
  assert.equal(pageNumberFor([0], 0), 1);
  assert.equal(pageNumberFor([0], 99999), 1);
});

// A run of empty pages produces repeated offsets. The LAST page starting at or
// before the position wins, which is the one a reader would turn to.
test("consecutive empty pages resolve to the last one that starts there", () => {
  // Pages 2 and 3 are empty, so all three start within two characters.
  assert.equal(pageNumberFor([0, 10, 12, 14], 13), 3);
  assert.equal(pageNumberFor([0, 10, 12, 14], 14), 4);
});

// ── The shape the chunker is stamped with ───────────────────────────────────

test("a chunk is stamped from where it BEGINS", () => {
  // A chunk running from 95 to 130 straddles the page-one/page-two boundary at
  // 102. It belongs to page 1 — where a reader looking for its first line would
  // turn — rather than to the page it happens to end on.
  assert.equal(pageNumberFor(OFFSETS, 95), 1);
});

// ── Pages for a book stored before pages were recorded ──────────────────────
// db/backfillPageNumbers.js re-extracts the original and writes pages only if
// the fresh text IS the stored text. A page computed against different text is
// a wrong citation shown with full confidence.

const BOOK = "עמוד אחד.\n\nעמוד שני כאן.\n\nעמוד שלישי.";
const BOOK_OFFSETS = [0, 11, 26];
const stored = (id, start, end, page = null) => ({ id, char_start: start, char_end: end, page_number: page, content: BOOK.slice(start, end) });

test("chunks that match the file get the page they begin on", () => {
  const { aligned, updates } = pagesForStoredChunks([stored(1, 0, 9), stored(2, 11, 24), stored(3, 26, 37)], BOOK, BOOK_OFFSETS);
  assert.equal(aligned, true);
  assert.deepEqual(updates, [{ id: 1, page_number: 1 }, { id: 2, page_number: 2 }, { id: 3, page_number: 3 }]);
});

test("one chunk that no longer matches the file stops the whole book", () => {
  const drifted = { ...stored(2, 11, 24), content: "טקסט שהשתנה" };
  const result = pagesForStoredChunks([stored(1, 0, 9), drifted], BOOK, BOOK_OFFSETS);
  assert.equal(result.aligned, false);
  assert.deepEqual(result.mismatches, [2]);
  assert.deepEqual(result.updates, [], "nothing is written for a book whose text has moved");
});

test("a chunk with no offsets cannot be checked, so it counts as a mismatch", () => {
  assert.equal(pagesForStoredChunks([{ id: 1, char_start: null, char_end: null, content: "x" }], BOOK, BOOK_OFFSETS).aligned, false);
});

test("a page already stored is left alone", () => {
  const { updates } = pagesForStoredChunks([stored(1, 0, 9, 1), stored(2, 11, 24)], BOOK, BOOK_OFFSETS);
  assert.deepEqual(updates, [{ id: 2, page_number: 2 }]);
});

test("a file with no page boundaries writes nothing", () => {
  assert.deepEqual(pagesForStoredChunks([stored(1, 0, 9)], BOOK, null).updates, []);
});

// ── A book's page without the book's text ───────────────────────────────────
// A sefer's chunks are megabytes; loading them on every visit to its page ran
// past query_timeout as a 503. ?content=0 leaves the words out.

test("the transcript can be read without the chunks' text", async () => {
  const { pool } = await import("../db/pool.js");
  const { stubPoolQuery } = await import("./setup.js");
  const { getTranscriptByMediaId } = await import("../services/transcripts/chunks.js");
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM media_items/i.test(text)) return { rows: [{ is_published: true, course_id: null, uploader_id: 1 }] };
    if (/FROM transcripts/i.test(text)) return { rows: [{ media_id: 20, status: "done" }] };
    return { rows: [{ id: 1, page_number: 4 }] };
  });
  try {
    await getTranscriptByMediaId(20, { courses: null, drafts: null }, { content: false });
    const read = stub.calls.find((c) => /FROM transcript_chunks/i.test(c.text));
    assert.doesNotMatch(read.text, /\bcontent\b/);
    assert.match(read.text, /page_number/, "where each passage is still comes back");

    await getTranscriptByMediaId(20, { courses: null, drafts: null });
    const full = stub.calls.filter((c) => /FROM transcript_chunks/i.test(c.text)).at(-1);
    assert.match(full.text, /, content FROM/, "every existing caller still gets the text");
  } finally {
    stub.restore();
  }
});
