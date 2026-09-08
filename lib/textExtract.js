// @ts-check
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { extensionOf } from "./mediaFormats.js";
import { badRequest } from "./AppError.js";
import { decodeTextBuffer } from "./textEncoding.js";

// Turning an uploaded book into plain text the LLM can summarise.
//
// The guiding rule for this whole file: NEVER return text we aren't confident
// is real. A summary is expensive and looks authoritative, so silently handing
// the model the empty string from a scanned PDF — or mojibake from a
// windows-1255 file read as UTF-8 — produces a confident, fabricated summary of
// nothing. Every failure mode below is therefore a loud AppError with a Hebrew
// message the lecturer can act on, not a best-effort fallback.
//
// AppError specifically (not a bare Error): the worker uses `instanceof
// AppError` to tell a permanent content problem — which must not be retried —
// from a transient infrastructure one, which should be.

// Encoding lives in lib/textEncoding.js, which imports nothing — the streaming
// controller needs the same answer when it serves a Hebrew .txt, and reaching
// for this module to get it would pull the PDF parser into the API process.
// Re-exported so the callers and tests that ask this file for it still can.
export { decodeTextBuffer };

// ── Cleaning ────────────────────────────────────────────────────────────────
// Control characters that survive extraction and mean nothing to the model.
// Soft hyphens in particular are common in justified book text and split words
// in half for both the tokenizer and full-text search.
// The rule below is disabled deliberately: matching control characters is the
// entire intent here — they are what this strips. Tab and newline are kept.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const SOFT_HYPHEN = /\u00AD/g;
// Zero-width + BiDi control marks. PDF extractors sprinkle these through RTL
// text; they are invisible, so they silently inflate token counts and break
// exact-match search on words that look identical on screen.
// Written as escapes deliberately — these characters are invisible in an editor,
// so a literal class here is impossible to review and trivial to corrupt.
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;
const NON_BREAKING_SPACE = /\u00A0/g;

// A line that is nothing but a page number ("42", "- 42 -", "עמוד 42"). These
// repeat on every page and, once the pages are joined, land in the middle of
// sentences.
const PAGE_NUMBER_LINE = /^\s*(?:[-–—[(]\s*)?(?:עמ['׳]?|עמוד|page|p\.)?\s*[\divxlcIVXLC]{1,6}\s*(?:[-–—\])]\s*)?$/i;

export const cleanExtractedText = (raw) => {
  const normalised = String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(SOFT_HYPHEN, "")
    .replace(ZERO_WIDTH, "")
    // Non-breaking space reads as a word character to some tokenizers.
    .replace(NON_BREAKING_SPACE, " ");

  const lines = normalised
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => !PAGE_NUMBER_LINE.test(line));

  return (
    lines
      .join("\n")
      // 3+ newlines collapse to the paragraph separator the chunker looks for.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
};

// Running headers/footers: the book's title or chapter name reprinted on every
// page. Extraction turns them into a line of noise between every two pages.
// Detected by repetition rather than position, since extractors do not reliably
// preserve where on the page a line sat.
const REPEAT_MIN_PAGES = 5;
const REPEAT_RATIO = 0.5;
// Long lines that happen to repeat are far more likely to be real content
// (a refrain, a repeated formula) than a running header.
const REPEAT_MAX_LINE_CHARS = 80;

export const stripRepeatedLines = (pages) => {
  if (pages.length < REPEAT_MIN_PAGES) return pages;

  const pageCount = new Map();
  for (const page of pages) {
    // Count each distinct line ONCE per page, so a word repeated many times
    // within a single page cannot look like a header.
    const seen = new Set(
      page
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && l.length <= REPEAT_MAX_LINE_CHARS)
    );
    for (const line of seen) pageCount.set(line, (pageCount.get(line) || 0) + 1);
  }

  const threshold = pages.length * REPEAT_RATIO;
  const headers = new Set(
    [...pageCount.entries()].filter(([, n]) => n >= threshold).map(([line]) => line)
  );
  if (headers.size === 0) return pages;

  return pages.map((page) =>
    page
      .split("\n")
      .filter((line) => !headers.has(line.trim()))
      .join("\n")
  );
};

// ── Quality gate ────────────────────────────────────────────────────────────
// A real book page carries 1,500–3,000 characters. A scanned page with no text
// layer carries approximately none. 100 is far below any genuine page and far
// above any scan, so the gap is wide enough that this needs no tuning.
// What joins one extracted page to the next. Two newlines, which is also the
// paragraph break the chunker splits on — so a page boundary is always a chunk
// boundary candidate, and never lands mid-sentence.
export const PAGE_SEPARATOR = "\n\n";

// Joins already-cleaned pages into the final text AND records where each one
// begins in it — built together, in one pass, so the offsets cannot drift from
// the string they describe.
//
// ── Why not compute the offsets from the page lengths afterwards ────────────
//
// Because that is wrong, and it is wrong in a way that looks right. The obvious
// version joins every page and cleans the result once more; the outer clean
// collapses a run of three or more newlines, and an EMPTY page — a blank leaf in
// a PDF, which is common — produces exactly such a run at its seams. The join
// then loses characters the arithmetic still counts, and every page label after
// the first blank leaf is off by a growing amount. Confidently wrong, which for
// a citation is worse than absent.
//
// So empty pages are kept out of the joined TEXT while keeping their place in
// the NUMBERING: page five is still page five after two blank leaves. An empty
// page is recorded at the position where the next text begins, which no chunk
// can point into anyway — a page with no characters has no content to bookmark.
//
// The result needs no second cleaning pass: every part is already trimmed and
// non-empty, so the join can contain neither a collapsible run nor leading or
// trailing whitespace.
export const joinPagesWithOffsets = (cleanedPages) => {
  const parts = [];
  const pageOffsets = [];
  let at = 0;

  for (const page of cleanedPages) {
    if (!page) {
      pageOffsets.push(at);
      continue;
    }
    if (parts.length > 0) at += PAGE_SEPARATOR.length;
    pageOffsets.push(at);
    parts.push(page);
    at += page.length;
  }

  return { text: parts.join(PAGE_SEPARATOR), pageOffsets };
};

export const SCANNED_MAX_CHARS_PER_PAGE = 100;

// Below this there is nothing to summarise, whatever the file claims to be.
export const MIN_WORDS_TO_SUMMARISE = 50;

export const countWords = (text) => {
  const trimmed = String(text ?? "").trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
};

export const isLikelyScanned = (text, pageCount) =>
  pageCount > 0 && text.length / pageCount < SCANNED_MAX_CHARS_PER_PAGE;

// ── Extractors (Strategy) ───────────────────────────────────────────────────
// One entry per format, all with the same shape: Buffer → { text, pageCount }.
// A new format is a new entry and nothing else — no branching to edit. This
// mirrors MIME_TYPES / MEDIA_TYPE_BY_EXT in mediaFormats.js, which is already
// how this codebase describes what it accepts.
//
// pageCount is 0 when the format has no concept of pages; only the PDF path can
// meaningfully answer "is this a scan?".

const extractTxt = async (buffer) => ({
  text: cleanExtractedText(decodeTextBuffer(buffer)),
  pageCount: 0,
});

const extractDocx = async (buffer) => {
  // extractRawText, not convertToHtml: the streaming controller wants HTML for
  // display, but the model wants prose. Passing it HTML spends tokens on markup
  // and puts tags inside the chunks that full-text search then indexes.
  const { value } = await mammoth.extractRawText({ buffer });
  return { text: cleanExtractedText(value), pageCount: 0 };
};

const extractPdf = async (buffer) => {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    // result.pages is the per-page text; result.text is the same content with
    // "-- 1 of 12 --" separators injected between pages. Joining the pages
    // ourselves keeps that marker out of the chunks, and per-page text is also
    // what makes the running-header and scanned-page detection possible.
    const pages = (result.pages ?? []).map((p) => p.text ?? "");
    const cleanedPages = stripRepeatedLines(pages).map(cleanExtractedText);

    // The text and the page boundaries are built together — see
    // joinPagesWithOffsets for why they cannot be derived separately. This is
    // what lets a chunk, and therefore a bookmark in a sefer, be cited as
    // "page 47" rather than only as a character offset.
    //
    // pageCount counts the pages the PDF actually has, including blank ones, so
    // it still matches what a reader sees in a viewer — and it is what
    // isLikelyScanned divides by.
    const { text, pageOffsets } = joinPagesWithOffsets(cleanedPages);

    return { text, pageCount: pages.length, pageOffsets };
  } finally {
    // Releases the pdf.js worker. Without it a worker process accumulates one
    // per book until it runs out of handles.
    await parser.destroy().catch(() => {});
  }
};

const EXTRACTORS = {
  txt: extractTxt,
  docx: extractDocx,
  pdf: extractPdf,
};

// Formats we accept on upload but deliberately refuse here, with the reason to
// show the user. Listing them explicitly beats a generic "unsupported": the
// lecturer needs to know that re-saving as .docx fixes it.
const REFUSED = {
  doc: "פורמט .doc הישן אינו נתמך להפקת סיכום. שמור את הקובץ כ־.docx ונסה שוב.",
};

// Extract plain text from an uploaded document.
//
// Returns { text, pageCount, words, extension }. Throws an AppError — meaning a
// permanent, user-facing problem — for anything that cannot produce usable text.
export const extractDocumentText = async (buffer, filename) => {
  const extension = extensionOf(filename);

  if (REFUSED[extension]) throw badRequest(REFUSED[extension]);

  const extractor = EXTRACTORS[extension];
  if (!extractor) {
    throw badRequest(`לא ניתן להפיק טקסט מקובץ מסוג .${extension || "?"}.`);
  }

  let extracted;
  try {
    extracted = await extractor(buffer);
  } catch (err) {
    // A parser that throws on the file itself (corrupt, encrypted, truncated)
    // is a permanent problem with THIS file, so it is surfaced as one rather
    // than retried three times against the same bytes.
    throw badRequest(`לא ניתן לקרוא את הקובץ — ייתכן שהוא פגום או מוגן בסיסמה. (${err.message})`);
  }

  const { text, pageCount, pageOffsets = null } = extracted;

  // Order matters: check "scanned" BEFORE "too short", because a scan is the
  // far more likely cause of an empty PDF and deserves the actionable message.
  if (isLikelyScanned(text, pageCount)) {
    throw badRequest(
      "הקובץ נראה כמסמך סרוק — תמונות ללא שכבת טקסט. הפקת סיכום דורשת קובץ שניתן לחלץ ממנו טקסט."
    );
  }

  const words = countWords(text);
  if (words < MIN_WORDS_TO_SUMMARISE) {
    throw badRequest(
      `לא נמצא מספיק טקסט קריא בקובץ (${words} מילים). נדרשות לפחות ${MIN_WORDS_TO_SUMMARISE} מילים להפקת סיכום.`
    );
  }

  // pageOffsets is null for every format that has no pages (.txt, .docx) and for
  // a PDF whose offsets could not be derived safely. Callers must treat it as
  // optional — which is the same shape migration 013 chose for start_time, and
  // for the same reason: a book has no timeline, and most documents have no
  // pages either.
  return { text, pageCount, pageOffsets, words, extension };
};
