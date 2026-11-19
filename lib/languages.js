// @ts-check
// The languages the INTERFACE comes in — the server's one list.
//
// The server needs it because it words what a user reads outside the browser:
// every mail is written in the recipient's users.locale. Content (transcripts,
// summaries, names) never follows it.
//
// The client holds the same list in src/i18n/languages.js, and
// test/languageMirror.test.js compares the two — cross-repository pair #8 in
// CLAUDE.md. Migration 051's CHECK holds the same codes. Change all three
// together.

/** @typedef {{ code: string, dir: "rtl" | "ltr" }} Language */

/** @type {readonly Language[]} */
export const LANGUAGES = Object.freeze([
  { code: "he", dir: "rtl" },
  { code: "yi", dir: "rtl" },
  { code: "en", dir: "ltr" },
  { code: "fr", dir: "ltr" },
  { code: "es", dir: "ltr" },
]);

// The default, and the fallback for any string a translation does not have.
export const DEFAULT_LANGUAGE = "he";

export const LANGUAGE_CODES = Object.freeze(LANGUAGES.map((l) => l.code));

/** @param {unknown} code */
export const isSupportedLanguage = (code) => typeof code === "string" && LANGUAGE_CODES.includes(code);

/** @param {unknown} code @returns {"rtl" | "ltr"} */
export const directionOf = (code) =>
  LANGUAGES.find((l) => l.code === code)?.dir ?? "rtl";
