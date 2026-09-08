import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { cleanExtractedText, PAGE_SEPARATOR, joinPagesWithOffsets } from "../lib/textExtract.js";
import { pageNumberFor } from "../services/transcripts/chunks.js";

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
