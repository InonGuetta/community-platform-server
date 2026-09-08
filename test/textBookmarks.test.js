import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { MAX_QUOTED_TEXT_CHARS } from "../controllers/controllersBookmarks.js";
import { ERROR_CODES } from "../lib/AppError.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// Bookmarking a place in a book.
//
// A bookmark used to REQUIRE a moment in time, which is right for a recording
// and makes the feature impossible for a document. It now takes either a second
// or a PASSAGE of text — and the interesting cases are all at the boundary
// between those two, which is why they are collected here rather than added to
// the existing bookmark tests.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

const USER = { id: 3, email: "u@example.com", role: "student", is_active: true };
const token = jwt.sign({ id: 3, email: USER.email, role: "student" }, process.env.JWT_SECRET, {
  expiresIn: "1h",
});

// A published book in the general library — visible to a student without an
// enrolment lookup, which is what keeps these tests about anchors.
const VISIBLE_BOOK = {
  id: 7,
  title: "ספר",
  media_type: "text",
  is_published: true,
  course_id: null,
  uploader_id: 1,
};

// One wide chunk, so a test can pick any offset inside it without arithmetic.
const CHUNK = { id: 55, char_start: 0, char_end: 9999, page_number: 12 };

// Captures every statement so the assertions read what reached Postgres rather
// than what the response echoed back.
//
// The matchers are ORDERED, and the order is load-bearing: the INSERT is itself
// a CTE that joins media_items, and servicesMedia's SELECT contains a
// `FROM transcript_chunks tc` subquery. Testing for the broad patterns first
// would answer the wrong query with the wrong row.
const capture = ({ media = VISIBLE_BOOK, chunk = CHUNK } = {}) => {
  const calls = [];
  stubPoolQuery(pool, (text, params) => {
    calls.push({ text, params });
    if (/FROM users/i.test(text)) return { rows: [USER] };
    if (/INSERT INTO bookmarks/i.test(text)) {
      return { rows: [{ id: 1, media_id: 7, char_position: params?.[4] ?? null }] };
    }
    if (/UPDATE bookmarks/i.test(text)) {
      return { rows: [{ id: 1, media_id: 7, note: params?.[0], media_title: "ספר", media_type: "text" }] };
    }
    // The anchor lookups. `\s+WHERE` rather than a bare table name: the media
    // SELECT carries `FROM transcript_chunks tc WHERE`, which must not match.
    if (/FROM transcript_chunks\s+WHERE/i.test(text)) return { rows: chunk ? [chunk] : [] };
    if (/FROM media_items m/i.test(text)) return { rows: media ? [media] : [] };
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
  "charPosition", "charEnd", "chunkId", "quotedText", "pageNumber",
];
const param = (calls, name) => insertOf(calls).params[INSERT_PARAMS.indexOf(name)];

// ── A passage, which is what the marker produces ────────────────────────────

test("a marked passage stores its range, its chunk and its quote", async () => {
  const calls = capture();
  const res = await post({
    mediaId: 7,
    chunkId: 55,
    charPosition: 4200,
    charEnd: 4260,
    quotedText: "ואמר רבי יוחנן",
    note: "כאן",
  });

  assert.equal(res.status, 201);
  assert.ok(insertOf(calls), "the request reached an INSERT");
  assert.equal(param(calls, "charPosition"), 4200);
  assert.equal(param(calls, "charEnd"), 4260);
  assert.equal(param(calls, "chunkId"), 55);
  assert.equal(param(calls, "quotedText"), "ואמר רבי יוחנן");
  assert.equal(param(calls, "timestampSeconds"), null, "a book has no timeline");
});

// The citation is copied at write time rather than read through the chunk later,
// because after a re-extraction the chunk is gone and the page is the only way
// left to find the passage by hand. See migration 026.
test("the page number is copied from the chunk, not taken from the client", async () => {
  const calls = capture();
  await post({ mediaId: 7, chunkId: 55, charPosition: 10, charEnd: 20, pageNumber: 999 });
  assert.equal(param(calls, "pageNumber"), 12, "the chunk's page wins over anything the body claims");
});

// A caller that sends only an offset — which is every caller written before the
// marker existed — still gets a resolved chunk and page.
test("an offset with no chunk id resolves to the chunk containing it", async () => {
  const calls = capture();
  const res = await post({ mediaId: 7, charPosition: 4200 });
  assert.equal(res.status, 201);
  assert.equal(param(calls, "chunkId"), 55, "resolved, not left null");
  assert.equal(param(calls, "pageNumber"), 12);
  assert.equal(param(calls, "charEnd"), null, "no end means a point anchor, and stays that way");
});

// ── Ranges that do not describe a passage ───────────────────────────────────

test("a passage that ends before it starts is refused", async () => {
  capture();
  const res = await post({ mediaId: 7, chunkId: 55, charPosition: 4260, charEnd: 4200 });
  assert.equal(res.status, 400);
});

test("an end with no start is refused", async () => {
  capture();
  const res = await post({ mediaId: 7, charEnd: 4200 });
  assert.equal(res.status, 400, "charEnd alone is not an anchor");
});

// Storing this would draw a highlight over text the user never marked, and the
// failure would appear later and silently, on the page rather than here.
test("a passage that runs past the end of its chunk is refused", async () => {
  capture({ chunk: { id: 55, char_start: 4000, char_end: 4999, page_number: 12 } });
  const res = await post({ mediaId: 7, chunkId: 55, charPosition: 4900, charEnd: 5200 });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, ERROR_CODES.BOOKMARK_ANCHOR_INVALID);
});

test("a position outside the chunk it names is refused", async () => {
  capture({ chunk: { id: 55, char_start: 4000, char_end: 4999, page_number: 12 } });
  const res = await post({ mediaId: 7, chunkId: 55, charPosition: 12 });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, ERROR_CODES.BOOKMARK_ANCHOR_INVALID);
});

// A chunk id from another book, or one that no longer exists because the book
// was re-extracted. Both come back as "no such chunk for this media item", which
// is the same answer and the same thing for the reader to do about it.
test("a chunk id that does not belong to this media item is refused", async () => {
  capture({ chunk: null });
  const res = await post({ mediaId: 7, chunkId: 999, charPosition: 10, charEnd: 20 });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, ERROR_CODES.BOOKMARK_ANCHOR_INVALID);
});

test("an offset that lands in no chunk at all is refused", async () => {
  capture({ chunk: null });
  const res = await post({ mediaId: 7, charPosition: 999999 });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, ERROR_CODES.BOOKMARK_ANCHOR_INVALID);
});

// A passage may fill its paragraph exactly — that is the boundary of the range
// check, and the value most likely to be refused by an off-by-one.
test("a passage may run to the very end of its chunk", async () => {
  capture({ chunk: { id: 55, char_start: 4000, char_end: 4999, page_number: 12 } });
  const res = await post({ mediaId: 7, chunkId: 55, charPosition: 4000, charEnd: 4999 });
  assert.equal(res.status, 201, "the chunk's last character is inside the chunk");
});

// Stored happily by the CHECK, listed in the panel, and rendered as nothing —
// segmentChunk drops a mark of zero width. The same shape of failure migration
// 022 exists to prevent, one level down.
test("a passage of zero length is refused, and says what was meant instead", async () => {
  capture();
  const res = await post({ mediaId: 7, chunkId: 55, charPosition: 4200, charEnd: 4200 });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, ERROR_CODES.BOOKMARK_ANCHOR_INVALID);
  assert.match(res.body.message, /omit charEnd/);
});

// A recording's chunks carry NULL offsets, so no character position can fall
// inside one. Without that exclusion in the lookup, `$2 BETWEEN NULL AND NULL`
// happens to be false — the right answer by accident rather than by rule.
test("a character offset cannot be anchored into a recording", async () => {
  capture({ chunk: null });
  const res = await post({ mediaId: 7, charPosition: 30 });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, ERROR_CODES.BOOKMARK_ANCHOR_INVALID);
});

// ── The quote is a label, not a copy of the book ────────────────────────────

test("an oversized quote is refused rather than stored", async () => {
  capture();
  const res = await post({
    mediaId: 7,
    chunkId: 55,
    charPosition: 10,
    charEnd: 20,
    quotedText: "א".repeat(MAX_QUOTED_TEXT_CHARS + 1),
  });
  assert.equal(res.status, 400);
});

test("a quote exactly at the limit is accepted", async () => {
  capture();
  const res = await post({
    mediaId: 7,
    chunkId: 55,
    charPosition: 10,
    charEnd: 20,
    quotedText: "א".repeat(MAX_QUOTED_TEXT_CHARS),
  });
  assert.equal(res.status, 201, "the boundary is inclusive, not one short");
});

test("a non-string quote is a 400, not a driver error", async () => {
  capture();
  const res = await post({ mediaId: 7, chunkId: 55, charPosition: 10, quotedText: { a: 1 } });
  assert.equal(res.status, 400);
});

// ── Point anchors, which migration 026 keeps storable on purpose ────────────

// Storing 0 would put every bookmark in every sefer at "00:00" in any query that
// orders or displays by time — the same reason migration 013 made start_time
// nullable for book chunks.
test("the missing timestamp is NULL rather than 0", async () => {
  const calls = capture();
  await post({ mediaId: 7, charPosition: 4200 });
  const timeParam = param(calls, "timestampSeconds");
  assert.equal(timeParam, null);
  assert.notEqual(timeParam, 0);
});

test("offset zero is a real position and is not treated as missing", async () => {
  const calls = capture();
  const res = await post({ mediaId: 7, charPosition: 0 });
  assert.equal(res.status, 201, "the first character of a book is a valid place to bookmark");
  assert.equal(param(calls, "charPosition"), 0);
});

// ── The old case, unchanged ─────────────────────────────────────────────────

test("a bookmark on a recording still works exactly as before", async () => {
  const calls = capture();
  const res = await post({ mediaId: 7, timestampSeconds: 754, note: "כאן" });
  assert.equal(res.status, 201);
  assert.equal(param(calls, "timestampSeconds"), 754);
});

test("timestamp zero still means the start of a recording", async () => {
  const calls = capture();
  const res = await post({ mediaId: 7, timestampSeconds: 0 });
  assert.equal(res.status, 201);
  assert.equal(param(calls, "timestampSeconds"), 0);
});

// A recording has no chunk offsets to check against, so nothing is resolved for
// it — and in particular a timestamp must never be looked up as a position.
test("a recording's bookmark does not go looking for a chunk", async () => {
  const calls = capture();
  await post({ mediaId: 7, timestampSeconds: 754 });
  const anchorLookup = calls.find((c) => /FROM transcript_chunks\s+WHERE/i.test(c.text));
  assert.equal(anchorLookup, undefined);
});

// ── Neither, and nonsense ───────────────────────────────────────────────────

// A bookmark anchored to nothing is visible in the list and impossible to jump
// to — worse than a refusal, because it cannot be told apart from a real one
// afterwards.
test("a bookmark with no anchor at all is refused", async () => {
  capture();
  const res = await post({ mediaId: 7, note: "לאן?" });
  assert.equal(res.status, 400);
});

test("mediaId is still required", async () => {
  capture();
  const res = await post({ charPosition: 10 });
  assert.equal(res.status, 400);
});

test("a non-numeric offset is a 400, not a driver error", async () => {
  capture();
  for (const bad of ["abc", -5, {}]) {
    const res = await post({ mediaId: 7, charPosition: bad });
    assert.equal(res.status, 400, `charPosition=${JSON.stringify(bad)} answered ${res.status}`);
  }
});

// A malformed body on an item the caller cannot see must still answer 400 for
// the body. Reversing the two checks turns every input error on an invisible
// item into a misleading "not found", and hides the real mistake from the
// developer making it.
test("a malformed body is refused before the media item is even loaded", async () => {
  const calls = capture({ media: null });
  const res = await post({ mediaId: 7, charPosition: "abc" });
  assert.equal(res.status, 400);
  assert.equal(calls.find((c) => /FROM media_items m/i.test(c.text)), undefined, "no query was paid for");
});

// ── Who may leave one ───────────────────────────────────────────────────────

// A bookmark stores no content of its own, so this is not a content leak — but
// it is written against any id the caller names, and the list it comes back in
// carries the item's title and type. That is enough to enumerate the archive,
// drafts included, through an endpoint nobody thinks of as a read.
test("a bookmark cannot be left on an item the caller may not see", async () => {
  const calls = capture({ media: { ...VISIBLE_BOOK, is_published: false } });
  const res = await post({ mediaId: 7, charPosition: 4200 });
  assert.equal(res.status, 404, "404, not 403 — a hidden item and a missing one are the same answer");
  assert.equal(res.body.code, ERROR_CODES.MEDIA_NOT_FOUND);
  assert.equal(insertOf(calls), undefined, "and nothing was written");
});

test("a bookmark on a media item that does not exist is a 404", async () => {
  const calls = capture({ media: null });
  const res = await post({ mediaId: 7, charPosition: 4200 });
  assert.equal(res.status, 404);
  assert.equal(insertOf(calls), undefined);
});

// ── The shape that comes back ───────────────────────────────────────────────

// The client appends the response straight into the list it already holds. A row
// without the title lands in a group headed "שיעור" in the neutral grey instead
// of under the lecture it belongs to, and stays wrong until the next reload —
// which is exactly what createBookmark was already fixed for, and updateBookmark
// was not.
test("editing a note answers with the media title, as creating one does", async () => {
  const calls = capture();
  const res = await request(app)
    .put("/api/bookmarks/1")
    .set("Cookie", `token=${token}`)
    .send({ note: "מעודכן" });

  assert.equal(res.status, 200);
  const update = calls.find((c) => /UPDATE bookmarks/i.test(c.text));
  assert.match(update.text, /media_title/, "the UPDATE joins the media item rather than RETURNING * alone");
  assert.match(update.text, /media_type/);
});

// ── What the reader needs to place one ──────────────────────────────────────

// The offsets are the coordinate space the bookmark lives in; without them on
// the chunks the reader has no way to turn a click into a position.
test("the transcript endpoint ships char offsets so the reader can anchor", async () => {
  let chunkSql = "";
  stubPoolQuery(pool, (text) => {
    if (/FROM transcript_chunks/i.test(text)) {
      chunkSql = text;
      return { rows: [] };
    }
    if (/FROM media_items/i.test(text)) return { rows: [{ is_published: true, course_id: null }] };
    if (/FROM transcripts/i.test(text)) return { rows: [{ id: 1, media_id: 7, status: "done" }] };
    if (/FROM users/i.test(text)) return { rows: [USER] };
    return { rows: [] };
  });

  const res = await request(app).get("/api/transcripts/7").set("Cookie", `token=${token}`);
  assert.equal(res.status, 200);
  assert.match(chunkSql, /char_start/);
  assert.match(chunkSql, /char_end/);
  // The reason that list is explicit in the first place.
  assert.doesNotMatch(chunkSql, /embedding/, "the vector must never ship to the client");
});
