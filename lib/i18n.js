// @ts-check
// The server's words, in the language of whoever reads them.
//
// The server words only what a person reads OUTSIDE the browser — mail, and
// the few pages it renders itself (the unsubscribe page, a lesson's share page,
// the document error page). Everything else it sends is a code the client words
// (ERROR_CODES, notification types). Content never passes through here.
//
// One file per language, locales/<code>.json, keys named by meaning. Hebrew is
// the default and the fallback for any key a translation does not have yet, so
// a half-translated language still reads; a key missing even in Hebrew comes
// back as the key itself, which a test catches before a reader does.

import { readFileSync, readdirSync } from "node:fs";
import { DEFAULT_LANGUAGE, directionOf, isSupportedLanguage } from "./languages.js";

const LOCALES_DIR = new URL("../locales/", import.meta.url);

/** @type {Record<string, any>} */
const STRINGS = Object.fromEntries(
  readdirSync(LOCALES_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => [file.replace(/\.json$/, ""), JSON.parse(readFileSync(new URL(file, LOCALES_DIR), "utf8"))])
);

/** A supported code, else Hebrew — users.locale is CHECKed, but a mail must never fail on it. */
/** @param {unknown} code */
export const resolveLocale = (code) => (isSupportedLanguage(code) ? /** @type {string} */ (code) : DEFAULT_LANGUAGE);

/** @param {any} tree @param {string} key */
const lookup = (tree, key) => key.split(".").reduce((node, part) => (node == null ? undefined : node[part]), tree);

/**
 * The words for `key` in `locale`, with {{name}} filled from `params`.
 * Values are inserted as given — a caller writing HTML escapes them first.
 * @param {unknown} locale
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 * @returns {string}
 */
export const translate = (locale, key, params = {}) => {
  const code = resolveLocale(locale);
  const value = lookup(STRINGS[code], key) ?? lookup(STRINGS[DEFAULT_LANGUAGE], key);
  if (typeof value !== "string") return key;
  return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
};

/**
 * Everything a writer needs for one reader: their `t`, and the lang/dir to set
 * on what it writes.
 * @param {unknown} locale
 */
export const forLocale = (locale) => {
  const lang = resolveLocale(locale);
  return {
    lang,
    dir: directionOf(lang),
    /** @param {string} key @param {Record<string, string|number>} [params] */
    t: (key, params) => translate(lang, key, params),
  };
};

// The locale Intl formats dates and numbers in — the client's INTL_LOCALES.
// Yiddish data is thin in Node's ICU, so Hebrew backs it.
const INTL_LOCALES = { he: "he-IL", yi: ["yi", "he-IL"], en: "en", fr: "fr", es: "es" };
/** @param {unknown} locale @returns {string | string[]} */
export const intlLocaleOf = (locale) => INTL_LOCALES[resolveLocale(locale)];

/** Every key path in the Hebrew file — for the tests that hold the languages together. */
export const hebrewKeys = () => {
  /** @type {string[]} */
  const keys = [];
  /** @param {any} node @param {string} prefix */
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object") walk(v, path);
      else keys.push(path);
    }
  };
  walk(STRINGS[DEFAULT_LANGUAGE] ?? {}, "");
  return keys;
};
