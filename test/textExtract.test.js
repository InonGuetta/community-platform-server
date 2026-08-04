import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeTextBuffer,
  cleanExtractedText,
  stripRepeatedLines,
  isLikelyScanned,
  countWords,
  extractDocumentText,
  MIN_WORDS_TO_SUMMARISE,
} from "../lib/textExtract.js";

// These cover the part of the book pipeline that can be tested for real —
// no database, no OpenAI. They exist because every failure here is silent:
// the wrong encoding, a scanned PDF or a running header does not throw, it just
// produces text that reads like text and summarises into confident nonsense.
//
// The invisible characters are built with String.fromCharCode rather than
// pasted: a literal soft hyphen or BiDi mark is unreviewable in a diff and is
// silently eaten by editors and copy-paste.
const SOFT_HYPHEN = String.fromCharCode(0x00ad);
const NBSP = String.fromCharCode(0x00a0);
const RTL_EMBED = String.fromCharCode(0x202b);
const RTL_MARK = String.fromCharCode(0x200f);
const LTR_MARK = String.fromCharCode(0x200e);

// ── Encoding ────────────────────────────────────────────────────────────────

test("decodes UTF-8 Hebrew unchanged", () => {
  const buffer = Buffer.from("שלום עולם", "utf8");
  assert.equal(decodeTextBuffer(buffer), "שלום עולם");
});

test("strips a UTF-8 BOM rather than leaving it in the first word", () => {
  const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("בראשית", "utf8")]);
  assert.equal(decodeTextBuffer(buffer), "בראשית");
});

test("falls back to windows-1255 for legacy Hebrew, not replacement characters", () => {
  // "שלום" in windows-1255 — invalid as UTF-8, which is the detection signal.
  const buffer = Buffer.from([0xf9, 0xec, 0xe5, 0xed]);
  const decoded = decodeTextBuffer(buffer);
  assert.equal(decoded, "שלום");
  assert.ok(!decoded.includes("�"), "must not contain replacement characters");
});

test("UTF-16LE with a BOM decodes rather than becoming interleaved NULs", () => {
  const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("תורה", "utf16le")]);
  assert.equal(decodeTextBuffer(buffer), "תורה");
});

// ── Cleaning ────────────────────────────────────────────────────────────────

test("removes soft hyphens that would split words for search and the tokenizer", () => {
  assert.equal(cleanExtractedText(`מפור${SOFT_HYPHEN}סם`), "מפורסם");
});

test("removes zero-width and BiDi control marks left by PDF extractors", () => {
  assert.equal(
    cleanExtractedText(`${RTL_EMBED}שלום${RTL_MARK} עולם${LTR_MARK}`),
    "שלום עולם"
  );
});

test("drops lines that are only a page number", () => {
  const cleaned = cleanExtractedText("פסקה ראשונה\n42\nפסקה שנייה\n- 43 -\nעמוד 44\nסוף");
  assert.equal(cleaned, "פסקה ראשונה\nפסקה שנייה\nסוף");
});

test("keeps a line that merely starts with a number", () => {
  assert.equal(cleanExtractedText("1. הקדמה לספר"), "1. הקדמה לספר");
});

test("collapses runs of blank lines to a single paragraph break", () => {
  assert.equal(cleanExtractedText("אחת\n\n\n\nשתיים"), "אחת\n\nשתיים");
});

test("converts non-breaking spaces to real spaces so word counts are right", () => {
  assert.equal(countWords(cleanExtractedText(`שלום${NBSP}עולם`)), 2);
});

// ── Running headers ─────────────────────────────────────────────────────────

test("strips a header repeated across most pages", () => {
  const pages = Array.from({ length: 8 }, (_, i) => `ספר הזוהר\nתוכן ייחודי לעמוד ${i}`);
  const stripped = stripRepeatedLines(pages);
  assert.ok(stripped.every((p) => !p.includes("ספר הזוהר")), "header should be gone");
  assert.ok(stripped[3].includes("תוכן ייחודי לעמוד 3"), "body must survive");
});

test("leaves a line repeated on only a few pages alone", () => {
  const pages = Array.from({ length: 10 }, (_, i) => (i < 3 ? "משפט חוזר\nגוף" : "גוף"));
  const stripped = stripRepeatedLines(pages);
  assert.ok(stripped[0].includes("משפט חוזר"), "3 of 10 pages is not a running header");
});

test("does not strip anything from a document too short to judge", () => {
  const pages = ["כותרת\nגוף", "כותרת\nגוף"];
  assert.deepEqual(stripRepeatedLines(pages), pages);
});

// ── Quality gate ────────────────────────────────────────────────────────────

test("flags a page with essentially no extractable text as a scan", () => {
  assert.equal(isLikelyScanned("", 12), true);
  assert.equal(isLikelyScanned("x".repeat(300), 12), true, "25 chars/page is a scan");
});

test("does not flag a genuine text page as a scan", () => {
  assert.equal(isLikelyScanned("x".repeat(2000 * 12), 12), false);
});

test("never calls a page-less format a scan", () => {
  assert.equal(isLikelyScanned("", 0), false, "a .txt has no pages to divide by");
});

// ── extractDocumentText: the permanent failures ─────────────────────────────
// Each of these must be an AppError, because that is what the worker uses to
// decide NOT to retry — retrying re-reads identical bytes to the same answer.

const isPermanent = (err) => err.name === "AppError" && err.statusCode === 400;

test("refuses .doc with an actionable message instead of failing inside mammoth", async () => {
  await assert.rejects(
    () => extractDocumentText(Buffer.from("anything"), "book.doc"),
    (err) => isPermanent(err) && err.message.includes(".docx")
  );
});

test("refuses an unsupported extension", async () => {
  await assert.rejects(
    () => extractDocumentText(Buffer.from("anything"), "book.epub"),
    isPermanent
  );
});

test("refuses a document with too little text to summarise", async () => {
  await assert.rejects(
    () => extractDocumentText(Buffer.from("שלום עולם", "utf8"), "note.txt"),
    (err) => isPermanent(err) && err.message.includes(String(MIN_WORDS_TO_SUMMARISE))
  );
});

test("accepts a .txt with enough content, reporting real counts", async () => {
  const body = Array.from({ length: 120 }, (_, i) => `מילה${i}`).join(" ");
  const result = await extractDocumentText(Buffer.from(body, "utf8"), "book.txt");
  assert.equal(result.words, 120);
  assert.equal(result.extension, "txt");
  assert.equal(result.pageCount, 0);
});

test("a corrupt file is a permanent failure, not a crash", async () => {
  await assert.rejects(
    () => extractDocumentText(Buffer.from("not a pdf at all"), "book.pdf"),
    isPermanent
  );
});
