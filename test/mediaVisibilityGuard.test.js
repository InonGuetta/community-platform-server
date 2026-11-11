import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";
import path from "node:path";
import { serverSourceFiles } from "./sourceFiles.js";

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

// Every door that takes a lesson's id and must not open for a lesson the caller
// may not see — through the real routes, with the lesson a colleague's draft.
// Each answers exactly what a lesson that does not exist answers: the same
// status, the same content type, the same bytes. Anything that differs between
// "hidden" and "missing" turns the id space into a catalogue of drafts.

const app = createApp();

const STUDENT = { id: 3, email: "s@example.com", role: "student", is_active: true };
const ADMIN = { id: 1, email: "a@example.com", role: "admin", is_active: true };
const tokenFor = (user) =>
  jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "1h" });

// Somebody else's draft: visible to an admin, hidden from a student.
const DRAFT = {
  id: 7, title: "טיוטה", media_type: "video", s3_key: "local/missing-file.mp4",
  is_published: false, course_id: null, uploader_id: 99, transcript_status: "done",
};

const HIDDEN_MEDIA = '{"message":"Media not found","code":"MEDIA_NOT_FOUND"}';
const HIDDEN_TRANSCRIPT = '{"message":"Transcript not found","code":"TRANSCRIPT_NOT_FOUND"}';
const JSON_TYPE = "application/json; charset=utf-8";

// `exists: false` answers every lookup of the lesson with no row.
const send = async (user, method, url, { body, accept, exists = true } = {}) => {
  const row = exists ? [DRAFT] : [];
  const db = stubPoolQuery(pool, (text) => {
    if (/FROM users/i.test(text)) return { rows: [user] };
    if (/FROM enrollments/i.test(text)) return { rows: [] };
    if (/FROM media_items/i.test(text) && /id\s*=\s*\$1/i.test(text)) return { rows: row };
    if (/FROM transcripts\b/i.test(text)) return { rows: [{ id: 1, media_id: 7, status: "done" }] };
    if (/COUNT\(\*\)/i.test(text)) return { rows: [{ count: 0 }] };
    return { rows: [] };
  });
  try {
    let req = request(app)[method](url).set("Cookie", `token=${tokenFor(user)}`);
    if (accept) req = req.set("Accept", accept);
    const res = await (body ? req.send(body) : req);
    return { status: res.status, type: res.headers["content-type"], text: res.text };
  } finally {
    db.restore();
  }
};

const DOORS = [
  ["the lesson", "get", "/api/media/7"],
  ["its session chat", "get", "/api/media/7/session-chat"],
  ["its watch position", "get", "/api/media/7/progress"],
  ["saving a watch position", "post", "/api/media/7/progress", { positionSeconds: 5 }],
  ["its stream", "get", "/api/media/7/stream"],
  ["its download", "get", "/api/media/7/download"],
  ["its audio extract", "get", "/api/media/7/download/audio"],
  ["a note about it", "post", "/api/notes", { title: "הערה", body: "<p>x</p>", mediaId: 7 }],
  ["a bookmark in it", "post", "/api/bookmarks", { mediaId: 7, timestampSeconds: 5 }],
  ["a like", "post", "/api/likes", { mediaId: 7 }],
  ["a save", "post", "/api/saves", { mediaId: 7 }],
  ["a search inside it", "get", "/api/discussion/7/search?q=" + encodeURIComponent("שבת")],
  ["its latest conversation", "get", "/api/discussion/7/conversation"],
  ["its conversations", "get", "/api/discussion/7/conversations"],
];

for (const [what, method, url, body] of DOORS) {
  test(`${what}: a hidden lesson answers exactly as a missing one`, async () => {
    const hidden = await send(STUDENT, method, url, { body });
    assert.deepEqual(hidden, { status: 404, type: JSON_TYPE, text: HIDDEN_MEDIA });
    const missing = await send(STUDENT, method, url, { body, exists: false });
    assert.deepEqual(missing, hidden);
  });

  // The control: the same request from somebody who may see the draft gets past
  // the guard, so the 404 above is the guard's and not something else's.
  test(`${what}: an admin gets past the guard`, async () => {
    const res = await send(ADMIN, method, url, { body });
    assert.notEqual(res.text, HIDDEN_MEDIA);
  });
}

test("the transcript: a hidden lesson answers exactly as a missing one, in the transcript's words", async () => {
  const hidden = await send(STUDENT, "get", "/api/transcripts/7");
  assert.deepEqual(hidden, { status: 404, type: JSON_TYPE, text: HIDDEN_TRANSCRIPT });
  assert.deepEqual(await send(STUDENT, "get", "/api/transcripts/7", { exists: false }), hidden);
  assert.notEqual((await send(ADMIN, "get", "/api/transcripts/7")).text, HIDDEN_TRANSCRIPT);
});

// Pinned as it is, not as it should be. When a browser asks the stream for a
// PAGE (an iframe, a new tab), a lesson that does not exist answers the HTML
// error page and a hidden one answers the JSON body — so the two CAN be told
// apart on this one route. Making them match is a change of behaviour, not a
// refactor; this test is here so that change is made on purpose.
test("the stream asked for a page: a missing lesson gets the HTML page, a hidden one the JSON body", async () => {
  const hidden = await send(STUDENT, "get", "/api/media/7/stream", { accept: "text/html" });
  assert.deepEqual(hidden, { status: 404, type: JSON_TYPE, text: HIDDEN_MEDIA });
  const missing = await send(STUDENT, "get", "/api/media/7/stream", { accept: "text/html", exists: false });
  assert.equal(missing.status, 404);
  assert.match(missing.type, /^text\/html/);
});

// ── One guard ───────────────────────────────────────────────────────────────
//
// The rule is lib/permissions.js's; applying it to a lesson, and the 404 that
// follows, is services/servicesVisibility.js's. Each door that wrote its own
// check — a controller helper, a notes helper, an inline test in the bookmarks,
// the transcript and the discussion — was a copy that could word the refusal its
// own way, and one that answered differently is how "hidden" and "missing"
// become distinguishable.

test("only servicesVisibility applies the visibility rule to a lesson", async () => {
  const files = await serverSourceFiles();
  assert.ok(files.length > 50, `only ${files.length} source files found`);
  const allowed = new Set([path.join("lib", "permissions.js"), path.join("services", "servicesVisibility.js")]);
  const applying = files
    .filter(({ file, source }) => !allowed.has(file) && /canSeeMediaRow\s*\(/.test(source))
    .map(({ file }) => file);
  assert.deepEqual(applying, [], `ask servicesVisibility instead: ${applying.join(", ")}`);
});

test("no handler writes a 404 itself", async () => {
  const files = (await serverSourceFiles()).filter(({ file }) => file.startsWith(`controllers${path.sep}`));
  assert.ok(files.length >= 10, `only ${files.length} controllers found`);
  const writing = files.filter(({ source }) => /status\(\s*404\s*\)/.test(source)).map(({ file }) => file);
  assert.deepEqual(writing, [], `throw the error instead, and let errorHandler answer: ${writing.join(", ")}`);
});
