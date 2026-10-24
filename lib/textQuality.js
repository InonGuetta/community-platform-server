// @ts-check
// ── How much of a book's extracted text is actually readable ─────────────────
//
// A PDF's text layer can exist and still be useless. Torah Temima (the first
// sefer in the archive) has one: its pages set the verse, Onkelos, Rashi and
// the commentary side by side, and the OCR behind the text layer read across
// the columns — "ה פ ט ר ת מ ח ר ת ד ש מל ק ט נ ע ר", "^?זמי". extractDocumentText
// catches a scan with NO text (lib/textExtract.js); nothing caught this. The
// book was processed, summarised and embedded, and the search and the chat
// then quietly covered only the third of it that could be read.
//
// So the share is measured once, when the text is extracted, and stored on the
// transcript (migration 033). The page warns from it; nothing is refused — a
// book that is two-thirds broken is still one-third useful.
//
// ── The measure ─────────────────────────────────────────────────────────────
//
// The text is cut into windows of WINDOW_WORDS. A window is readable when at
// least WORD_SHARE of its tokens look like Hebrew words: two or more Hebrew
// letters, with the quote marks of an abbreviation and trailing punctuation
// allowed. The result is the percentage of readable windows.
//
// Calibrated on the archive as it stood (October 2026): every Whisper
// transcript — 20 lessons — scores ≥ 0.94 even in its weakest tenth of
// chunks; the broken book has a median of 0.71 and a weakest tenth of 0.44.
// 0.8 sits in the gap between them.

const WINDOW_WORDS = 200;
const WORD_SHARE = 0.8;

// Below this, the page tells the reader the search and chat are partial.
// Exported so the threshold the client warns at is not a second guess.
export const LOW_TEXT_QUALITY = 80;

const HEBREW_WORD = /^[("'׳״]?[א-ת]{2,}(["'׳״][א-ת]*)?[.,:;!?)"'׳״]*$/;

/** The share (0–1) of a passage's tokens that look like Hebrew words. */
export const wordShare = (text) => {
  const tokens = String(text).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  return tokens.filter((t) => HEBREW_WORD.test(t)).length / tokens.length;
};

/**
 * The percentage (0–100) of the text that is readable, or null when there is
 * too little text to say.
 * @param {string} text
 */
export const textQuality = (text) => {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  let windows = 0;
  let readable = 0;
  for (let i = 0; i < words.length; i += WINDOW_WORDS) {
    windows += 1;
    if (wordShare(words.slice(i, i + WINDOW_WORDS).join(" ")) >= WORD_SHARE) readable += 1;
  }
  return Math.round((readable * 100) / windows);
};
