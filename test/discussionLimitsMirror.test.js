import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "fs/promises";
import { MAX_QUERY_CHARS, MAX_QUESTION_CHARS } from "../controllers/controllersDiscussion.js";

// The "דיון עם AI" tab's two length limits, checked against the client's
// copies.
//
// The client cuts the text box off at the same length the server refuses, so a
// reader can never type something that is then rejected. If the two drift, the
// failure is silent in the direction that matters: raise the server's limit and
// the box still stops short; lower it and the box lets through text that comes
// back as a 400 — which the pane shows as a generic failure, and the reader
// retries the same question forever.
//
// Read as TEXT, like every mirror test here: the client is a separate npm
// package, and importing it would pull its dependency graph into this suite.

const clientFile = (path) =>
  readFile(new URL(`../../community-platform-client/src/components/pages/mediaView/componentsMediaView/AIDiscussion/${path}`, import.meta.url), "utf8");

const constantIn = (source, name) => {
  const match = new RegExp(`const ${name} = (\\d+);`).exec(source);
  return match ? Number(match[1]) : null;
};

test("the search box stops where the server's limit is", async () => {
  const value = constantIn(await clientFile("SmartSearchPane.jsx"), "MAX_QUERY_CHARS");
  assert.notEqual(value, null, "the client's MAX_QUERY_CHARS was not found — moved or renamed?");
  assert.equal(value, MAX_QUERY_CHARS);
});

test("the question box stops where the server's limit is", async () => {
  const value = constantIn(await clientFile("ChatPane.jsx"), "MAX_QUESTION_CHARS");
  assert.notEqual(value, null, "the client's MAX_QUESTION_CHARS was not found — moved or renamed?");
  assert.equal(value, MAX_QUESTION_CHARS);
});
