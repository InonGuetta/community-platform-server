import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import * as controllersNotes from "../controllers/controllersNotes.js";

// A note may point at a lecture, and the notes list joins that lecture back in to
// show its title. Nothing checked the caller was entitled to the lecture, which
// made "create a note against an id, then read your notes" a way to read the
// title of an unpublished draft — the one place the is_published gate was missing.

const STUDENT = { id: 7, role: "student" };
const LECTURER = { id: 2, role: "lecturer" };

const DRAFT = { id: 9, is_published: false, uploader_id: 2, title: "טיוטה שלא פורסמה" };
const PUBLISHED = { id: 3, is_published: true, uploader_id: 2, title: "שיעור פתוח" };

const fakeRes = () => ({
  statusCode: 0,
  body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});

// The media lookup answers first; anything after it is the note INSERT.
const stubFor = (mediaRow) => {
  const calls = [];
  const stub = stubPoolQuery(pool, (text, params) => {
    calls.push({ text, params });
    if (/FROM media_items/i.test(text)) return { rows: mediaRow ? [mediaRow] : [] };
    return { rows: [{ id: 1, user_id: 7, media_id: mediaRow?.id ?? null }] };
  });
  return { calls, restore: stub.restore };
};

test("a student cannot attach a note to an unpublished draft", async () => {
  const db = stubFor(DRAFT);
  try {
    const req = { user: STUDENT, body: { title: "x", body: "y", mediaId: 9 } };
    await assert.rejects(() => controllersNotes.createNote(req, fakeRes()), { statusCode: 404 });
    assert.equal(
      db.calls.some((c) => /INSERT INTO notes/i.test(c.text)),
      false,
      "the note must not be written against media the caller cannot see"
    );
  } finally {
    db.restore();
  }
});

// The same 404 as the media and transcript endpoints: an id that exists but is
// hidden has to be indistinguishable from one that does not, or the endpoint
// becomes a way to enumerate the library.
test("a hidden draft and a missing id are reported identically", async () => {
  const hidden = stubFor(DRAFT);
  let hiddenStatus;
  try {
    await controllersNotes
      .createNote({ user: STUDENT, body: { mediaId: 9 } }, fakeRes())
      .catch((err) => { hiddenStatus = err.statusCode; });
  } finally {
    hidden.restore();
  }

  const missing = stubFor(null);
  let missingStatus;
  try {
    await controllersNotes
      .createNote({ user: STUDENT, body: { mediaId: 12345 } }, fakeRes())
      .catch((err) => { missingStatus = err.statusCode; });
  } finally {
    missing.restore();
  }

  assert.equal(hiddenStatus, 404);
  assert.equal(missingStatus, 404);
});

test("a lecturer may attach a note to a draft, as they may see it", async () => {
  const db = stubFor(DRAFT);
  try {
    const res = fakeRes();
    await controllersNotes.createNote({ user: LECTURER, body: { mediaId: 9 } }, res);
    assert.equal(res.statusCode, 201);
  } finally {
    db.restore();
  }
});

test("a published lecture is attachable by anyone", async () => {
  const db = stubFor(PUBLISHED);
  try {
    const res = fakeRes();
    await controllersNotes.createNote({ user: STUDENT, body: { mediaId: 3 } }, res);
    assert.equal(res.statusCode, 201);
  } finally {
    db.restore();
  }
});

// A note with no lecture behind it is the ordinary case — the notebook is full of
// them — and it must not pay for a lookup it does not need.
test("a free note is written without a media lookup", async () => {
  const db = stubFor(null);
  try {
    const res = fakeRes();
    await controllersNotes.createNote({ user: STUDENT, body: { title: "מחשבה" } }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(
      db.calls.some((c) => /FROM media_items/i.test(c.text)),
      false,
      "an unattached note should not query media at all"
    );
  } finally {
    db.restore();
  }
});
