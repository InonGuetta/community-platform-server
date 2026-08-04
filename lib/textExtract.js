// @ts-check
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { extensionOf } from "./mediaFormats.js";
import { badRequest } from "./AppError.js";

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

// ── Encoding ────────────────────────────────────────────────────────────────
// Hebrew .txt files in the wild are frequently windows-1255, not UTF-8. Read
// with the wrong one and every Hebrew letter becomes a replacement character,
// which then flows all the way to the model as garbage. There is no header to
// consult, so this decides by trying the strict decoder and watching it fail.
const BOMS = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: "utf-8", skip: 3 },
  { bytes: [0xff, 0xfe], encoding: "utf-16le", skip: 2 },
  { bytes: [0xfe, 0xff], encoding: "utf-16be", skip: 2 },
];

const matchesBom = (buffer, bytes) =>
  buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b);

// Legacy Hebrew code page. windows-1255 is a superset of ISO-8859-8 for the
// letters themselves, so it is the safer single guess for both.
const LEGACY_HEBREW_ENCODING = "windows-1255";

export const decodeTextBuffer = (buffer) => {
  for (const { bytes, encoding, skip } of BOMS) {
    if (matchesBom(buffer, bytes)) {
      return new TextDecoder(encoding).decode(buffer.subarray(skip));
    }
  }

  // No BOM. Strict UTF-8 throws on any byte sequence that isn't valid UTF-8,
  // which is exactly the signal that this is a legacy single-byte file — a
  // non-strict decode would instead return U+FFFD and look like success.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder(LEGACY_HEBREW_ENCODING).decode(buffer);
  }
};

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
    return {
      text: cleanExtractedText(cleanedPages.join("\n\n")),
      pageCount: pages.length,
    };
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

  const { text, pageCount } = extracted;

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

  return { text, pageCount, words, extension };
};
