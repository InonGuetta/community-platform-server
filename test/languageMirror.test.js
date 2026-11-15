import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "fs/promises";
import { LANGUAGES } from "../lib/languages.js";

// Cross-repository pair #8 (CLAUDE.md): the interface languages. The server
// words mail in a user's users.locale, the client offers the languages to pick
// from and sets the page's direction — a code on one side only would be a
// language the switcher offers and the mail cannot write, or the reverse, with
// nothing failing anywhere.
//
// Read as TEXT, like the other mirror tests: the client is a separate package,
// and importing across the boundary would pull its dependencies in here.

const CLIENT_FILE = new URL("../../community-platform-client/src/i18n/languages.js", import.meta.url);

const parseClient = (source) =>
  [...source.matchAll(/\{\s*code:\s*"([^"]+)",\s*name:\s*"[^"]*",\s*dir:\s*"(rtl|ltr)"\s*\}/g)].map(([, code, dir]) => ({
    code,
    dir,
  }));

test("the client offers exactly the server's languages, in the same order and direction", async () => {
  const client = parseClient(await readFile(CLIENT_FILE, "utf8"));
  // A moved or reshaped file would otherwise compare two empty lists and pass.
  assert.ok(client.length > 0, "no languages were parsed from the client's src/i18n/languages.js");
  assert.deepEqual(client, LANGUAGES.map(({ code, dir }) => ({ code, dir })));
});

test("both sides fall back to Hebrew", async () => {
  const source = await readFile(CLIENT_FILE, "utf8");
  assert.match(source, /export const DEFAULT_LANGUAGE = "he";/);
});
