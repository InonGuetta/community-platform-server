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

// A bookmark placed on the PAGE of the original file — the third kind of anchor.
//
// The first two describe a moment in a recording and a passage in the EXTRACTED
// text. Neither can express what a reader does in the "מקור" tab, and for a
// scanned sefer the extracted text is a poor translation of the document: the
// OCR in this archive misreads freely, so a bookmark anchored to those words can
// only be found by searching for words that are wrong.
//
// This one is geometry. A page, and a rectangle on it as fractions of the page —
// so it survives zoom, window width and a different device, and owes nothing to
// the OCR. See migration 027.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

const USER = { id: 3, email: "u@example.com", role: "student", is_active: true };
const token = jwt.sign({ id: 3, email: USER.email, role: "student" }, process.env.JWT_SECRET, {
  expiresIn: "1h",
});

const VISIBLE_BOOK = {
  id: 7, title: "תורה תמימה", media_type: "text",
  is_published: true, course_id: null, uploader_id: 1,
};

const capture = () => {
  const calls = [];
  stubPoolQuery(pool, (text, params) => {
    calls.push({ text, params });
    if (/FROM users/i.test(text)) return { rows: [USER] };
    if (/INSERT INTO bookmarks/i.test(text)) return { rows: [{ id: 1, media_id: 7 }] };
    if (/FROM transcript_chunks\s+WHERE/i.test(text)) return { rows: [] };
    if (/FROM media_items m/i.test(text)) return { rows: [VISIBLE_BOOK] };
    return { rows: [] };
  });
  return calls;
};

const post = (body) =>
  request(app).post("/api/bookmarks").set("Cookie", `token=${token}`).send(body);

const insertOf = (calls) => calls.find((c) => /INSERT INTO bookmarks/i.test(c.text));

// The INSERT's parameter list, by name, so an assertion says what it means and a
// reordered statement fails loudly instead of asserting the wrong column.
const INSERT_PARAMS = [
  "userId", "mediaId", "timestampSeconds", "note",
  "charPosition", "charEnd", "chunkId", "quotedText",
  "pageNumber", "rectX", "rectY", "rectW", "rectH",
];
const param = (calls, name) => insertOf(calls).params[INSERT_PARAMS.indexOf(name)];

const PLACE = { mediaId: 7, pageNumber: 9, rect: { x: 0.12, y: 0.4315, w: 0.63, h: 0.021 } };

// ── The anchor itself ───────────────────────────────────────────────────────

test("a place on a page is stored as a page and four fractions", async () => {
  const calls = capture();
  const res = await post({ ...PLACE, quotedText: "בָּעֵת הַהִוא לֵאמֹר", note: "כאן" });

  assert.equal(res.status, 201);
  assert.equal(param(calls, "pageNumber"), 9);
  assert.equal(param(calls, "rectX"), 0.12);
  assert.equal(param(calls, "rectY"), 0.4315);
  assert.equal(param(calls, "rectW"), 0.63);
  assert.equal(param(calls, "rectH"), 0.021);
});

// It owes nothing to the extraction, which is the whole point: re-running the
// pipeline deletes every chunk and cannot touch this.
test("it carries neither a timestamp nor a position in the extracted text", async () => {
  const calls = capture();
  await post(PLACE);
  assert.equal(param(calls, "timestampSeconds"), null);
  assert.equal(param(calls, "charPosition"), null);
  assert.equal(param(calls, "chunkId"), null);
});

// The OCR misreads freely, so the words are a LABEL for the list and never the
// way the mark is found again.
test("the words it was drawn over are kept, however they were read", async () => {
  const calls = capture();
  await post({ ...PLACE, quotedText: "טקסט משובש מ-OCR" });
  assert.equal(param(calls, "quotedText"), "טקסט משובש מ-OCR");
});

test("and are optional — a mark with no readable text is still a place", async () => {
  const calls = capture();
  const res = await post(PLACE);
  assert.equal(res.status, 201);
  assert.equal(param(calls, "quotedText"), null);
});

// ── What is refused ─────────────────────────────────────────────────────────

test("a bookmark with no anchor of any of the three kinds is refused", async () => {
  capture();
  const res = await post({ mediaId: 7, note: "לאן?" });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /rect/);
});

// Three sides describe nothing. Storing a partial rectangle would put a row in
// the list that cannot be drawn — the failure migration 022's constraint exists
// to prevent, one level down.
test("a rectangle missing a side is refused, and the message names it", async () => {
  capture();
  const res = await post({ mediaId: 7, pageNumber: 9, rect: { x: 0.1, y: 0.2, w: 0.3 } });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /h/);
});

test("a rectangle outside the page is refused", async () => {
  capture();
  for (const rect of [
    { x: -0.1, y: 0.2, w: 0.3, h: 0.02 },
    { x: 0.1, y: 1.4, w: 0.3, h: 0.02 },
    { x: 0.1, y: 0.2, w: 3, h: 0.02 },
  ]) {
    const res = await post({ mediaId: 7, pageNumber: 9, rect });
    assert.equal(res.status, 400, `${JSON.stringify(rect)} answered ${res.status}`);
  }
});

// A rectangle with no area cannot be seen, so it is a mark nobody can find —
// the same shape of failure as a passage of zero length.
test("a rectangle with no area is refused", async () => {
  capture();
  const res = await post({ mediaId: 7, pageNumber: 9, rect: { x: 0.1, y: 0.2, w: 0, h: 0.02 } });
  assert.equal(res.status, 400);
});

test("a rectangle with no page is a place on no page at all", async () => {
  capture();
  const res = await post({ mediaId: 7, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.02 } });
  assert.equal(res.status, 400);
});

test("a non-numeric side is a 400, not a driver error", async () => {
  capture();
  const res = await post({ mediaId: 7, pageNumber: 9, rect: { x: "left", y: 0.2, w: 0.3, h: 0.02 } });
  assert.equal(res.status, 400);
});

test("a rect that is not an object at all is refused", async () => {
  capture();
  for (const rect of ["0.1,0.2", [0.1, 0.2, 0.3, 0.4]]) {
    const res = await post({ mediaId: 7, pageNumber: 9, rect });
    assert.equal(res.status, 400, `${JSON.stringify(rect)} answered ${res.status}`);
  }
});

// ── The other two kinds are untouched ───────────────────────────────────────

test("a recording's bookmark still works exactly as before", async () => {
  const calls = capture();
  const res = await post({ mediaId: 7, timestampSeconds: 754, note: "כאן" });
  assert.equal(res.status, 201);
  assert.equal(param(calls, "timestampSeconds"), 754);
  assert.equal(param(calls, "rectX"), null);
});

// ── The read ────────────────────────────────────────────────────────────────

// Without page_number in the ORDER BY every page anchor ties on the first three
// keys, and a sefer's marks come back in whatever order the planner felt like —
// the same failure the client's comparator had.
test("the listing orders page anchors by page", async () => {
  let sql = "";
  stubPoolQuery(pool, (text) => {
    if (/FROM users/i.test(text)) return { rows: [USER] };
    if (/FROM bookmarks b/i.test(text)) { sql = text; return { rows: [] }; }
    return { rows: [] };
  });

  const res = await request(app).get("/api/bookmarks").set("Cookie", `token=${token}`);
  assert.equal(res.status, 200);
  assert.match(sql, /ORDER BY[\s\S]*page_number/i);
});
