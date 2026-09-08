// @ts-check
// Working out what bytes a text file is actually written in.
//
// ── Why this is its own module ──────────────────────────────────────────────
//
// It lived inside lib/textExtract.js, which imports mammoth and pdf-parse. That
// was fine while the only caller was the LLM worker, which needs those anyway.
// It stopped being fine when the STREAMING controller needed the same answer:
// serving a Hebrew .txt correctly means knowing its encoding, and reaching for
// textExtract to find that out would pull the PDF parser into the API process
// for the sake of a fifteen-line function.
//
// mediaFormats.js already states this principle for the same reason — "the API
// process needs the *answer* ... but must not pull in the PDF parser to get it".
// This is the second answer that has to be available without the parser.
//
// Nothing here imports anything at all, which is what makes it free to import.

// ── Encoding ────────────────────────────────────────────────────────────────
// Hebrew .txt files in the wild are frequently windows-1255, not UTF-8. Read
// with the wrong one and every Hebrew letter becomes a replacement character,
// which then flows all the way to the model as garbage — or, on the serving
// path, onto the reader's screen. There is no header to consult, so this decides
// by trying the strict decoder and watching it fail.
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
