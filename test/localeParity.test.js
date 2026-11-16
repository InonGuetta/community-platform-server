import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { LANGUAGE_CODES, DEFAULT_LANGUAGE } from "../lib/languages.js";

// Every language the server writes in says everything Hebrew says, and nothing
// else (locales/<code>.json, lib/i18n.js). A key missing from a translation
// falls back to Hebrew in the middle of an English mail, and a {{variable}}
// spelled differently reaches the inbox as "{{title}}" — neither raises
// anything at runtime. Top-level keys starting "_" are markers (a draft's
// "_draft"), not words.

const LOCALES = new URL("../locales/", import.meta.url);
const read = (code) => JSON.parse(readFileSync(new URL(`${code}.json`, LOCALES), "utf8"));

const flatten = (node, prefix = "", out = {}) => {
  for (const [key, value] of Object.entries(node)) {
    if (!prefix && key.startsWith("_")) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") flatten(value, path, out);
    else out[path] = value;
  }
  return out;
};
const variables = (text) => [...String(text).matchAll(/\{\{\s*(\w+)/g)].map((m) => m[1]).sort().join(",");

test("there is a file for every interface language, and no others", () => {
  const files = readdirSync(LOCALES).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  assert.deepEqual(files.sort(), [...LANGUAGE_CODES].sort());
});

const hebrew = flatten(read(DEFAULT_LANGUAGE));

test("the Hebrew keys were found", () => {
  assert.ok(Object.keys(hebrew).length > 60);
});

for (const code of LANGUAGE_CODES.filter((c) => c !== DEFAULT_LANGUAGE)) {
  test(`${code}: the same keys and variables as Hebrew`, () => {
    const other = flatten(read(code));
    assert.deepEqual(Object.keys(hebrew).filter((k) => !(k in other)), [], "missing in the translation");
    assert.deepEqual(Object.keys(other).filter((k) => !(k in hebrew)), [], "only in the translation");
    for (const key of Object.keys(hebrew)) {
      assert.equal(variables(other[key]), variables(hebrew[key]), `{{variables}} of ${key}`);
    }
  });
}
