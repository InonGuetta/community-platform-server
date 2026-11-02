import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { NOTE_PREVIEW_CHARS } from "../services/servicesNotes.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// The notebook's reads (PRD NOTE-17): a light list, whole notes by id, a
// lesson's notes, and search over the whole text.

after(async () => {
  await Promise.all([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();
const USER = { id: 7, email: "u@example.com", role: "student" };
const cookie = `token=${jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: "1h" })}`;

const NOTES_READ = /FROM notes n/;

const read = async (query, rows = []) => {
  let sent = null;
  const stub = stubPoolQuery(pool, (text, params) => {
    if (/FROM users/.test(text) && !/notes/.test(text)) return { rows: [USER] };
    if (/FROM enrollments/.test(text)) return { rows: [] };
    if (NOTES_READ.test(text)) {
      sent = { text, params };
      return { rows };
    }
    return { rows: [] };
  });
  try {
    const res = await request(app).get(`/api/notes${query}`).set("Cookie", cookie);
    return { res, sent };
  } finally {
    stub.restore();
  }
};

test("the list is light: a preview, and no body", async () => {
  const { res, sent } = await read("", [{ id: 1, title: "א", preview: "שורה ראשונה" }]);
  assert.equal(res.status, 200);
  assert.doesNotMatch(sent.text, /n\.\*/, "the list must not select every column — that includes the body");
  assert.doesNotMatch(sent.text, /n\.body\b(?!_text)/, "nor the body by name");
  assert.match(sent.text, new RegExp(`LEFT\\(n\\.body_text, ${NOTE_PREVIEW_CHARS}\\) AS preview`));
  assert.match(sent.text, /WHERE n\.user_id=\$1/);
  assert.deepEqual(res.body, [{ id: 1, title: "א", preview: "שורה ראשונה" }]);
});

test("search reads the whole text, not the preview, and matches it literally", async () => {
  const { res, sent } = await read("?q=" + encodeURIComponent("100%_תפילה"));
  assert.equal(res.status, 200);
  assert.match(sent.text, /n\.body_text ILIKE \$4/);
  assert.match(sent.text, /n\.title ILIKE \$4/);
  assert.equal(sent.params[3], "%100\\%\\_תפילה%", "% and _ are the user's text, not wildcards");
});

test("whole notes by id are only ever the caller's", async () => {
  const { res, sent } = await read("?ids=3,5", [{ id: 3, body: "<p>x</p>", body_text: "x" }]);
  assert.equal(res.status, 200);
  assert.match(sent.text, /n\.user_id=\$1 AND n\.id = ANY\(\$4::int\[\]\)/);
  assert.deepEqual(sent.params[3], [3, 5]);
  assert.equal(res.body[0].body, "<p>x</p>");
  assert.equal("body_text" in res.body[0], false, "the words are not sent twice");
});

test("a lesson's notes: attached to it, or quoting it with a chip", async () => {
  const { res, sent } = await read("?aboutMediaId=4");
  assert.equal(res.status, 200);
  assert.match(sent.text, /n\.media_id = \$4 OR position\(\$5 in COALESCE\(n\.body, ''\)\) > 0/);
  // The closing quote keeps lesson 4 from matching a chip for lesson 49.
  assert.equal(sent.params[4], 'data-media-id="4"');
  assert.match(sent.text, /n\.user_id=\$1/);
});

test("one question at a time, and well-formed", async () => {
  for (const query of ["?ids=1&q=a", "?ids=1&aboutMediaId=2", "?ids=x", "?ids=1,1", "?aboutMediaId=abc"]) {
    const { res, sent } = await read(query);
    assert.equal(res.status, 400, query);
    assert.equal(sent, null, `${query} reached the database`);
  }
});
