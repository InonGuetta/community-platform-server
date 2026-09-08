import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { LOCAL_UPLOAD_DIR } from "../lib/storage.js";
import { ERROR_CODES } from "../lib/AppError.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// Serving the ORIGINAL file — the reader's "מקור" tab.
//
// This path is the one place a document is handed to the browser as bytes rather
// than as extracted text, and two of its failures were invisible from the code:
// one arrived as a 500 on a file the server could never have shown, and the
// other was not an error at all, just Hebrew that came out as mojibake.
//
// The files below are written into the real upload directory, because that is
// what the local-storage branch reads. `pool` stays stubbed — the point is the
// controller, not the database.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

const USER = { id: 3, email: "u@example.com", role: "student", is_active: true };
const token = jwt.sign({ id: 3, email: USER.email, role: "student" }, process.env.JWT_SECRET, {
  expiresIn: "1h",
});

const written = [];

// A real file under LOCAL_UPLOAD_DIR, and the s3_key that points at it.
const givenFile = (name, contents) => {
  fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
  const filename = `test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`;
  const filePath = path.join(LOCAL_UPLOAD_DIR, filename);
  fs.writeFileSync(filePath, contents);
  written.push(filePath);
  return `local/${filename}`;
};

after(() => {
  for (const filePath of written) fs.rmSync(filePath, { force: true });
});

const givenMedia = (s3Key, mediaType = "text") => {
  stubPoolQuery(pool, (text) => {
    if (/FROM users/i.test(text)) return { rows: [USER] };
    if (/FROM media_items m/i.test(text)) {
      return {
        rows: [{
          id: 7, title: "ספר", media_type: mediaType, s3_key: s3Key,
          is_published: true, course_id: null, uploader_id: 1,
        }],
      };
    }
    return { rows: [] };
  });
};

const stream = () => request(app).get("/api/media/7/stream").set("Cookie", `token=${token}`);
const download = () => request(app).get("/api/media/7/download").set("Cookie", `token=${token}`);

// ── B6 · a format that cannot be displayed ──────────────────────────────────

// mammoth reads the DOCX zip, not the legacy binary format, so a .doc reached
// the converter and threw somewhere inside it. That surfaced as a 500 — a server
// fault — on a file that was never displayable and never will be.
test("a .doc is refused with a reason instead of dying inside the converter", async () => {
  // Deliberately not a real .doc: the point is that nothing tries to parse it.
  givenMedia(givenFile("old.doc", "not a zip, and never was"));

  const res = await stream();
  assert.equal(res.status, 400, `answered ${res.status}`);
  assert.equal(res.body.code, ERROR_CODES.UNVIEWABLE_TEXT_FORMAT);
});

// The file is perfectly fine — it is only unopenable by this stack. Taking the
// download away as well would leave the user with no way to reach their own
// upload at all.
test("but it can still be downloaded", async () => {
  givenMedia(givenFile("old.doc", "not a zip, and never was"));

  const res = await download();
  assert.equal(res.status, 200);
  assert.match(res.headers["content-disposition"], /attachment/);
});

// A .docx must REACH the converter — the unviewable guard is about .doc alone.
// A corrupt one then fails on its own merits, which is a different answer with
// different advice: there is nothing to re-save, the file itself is broken.
test("a corrupt .docx is a problem with the file, not a server fault", async () => {
  givenMedia(givenFile("modern.docx", "PK-ish but not really"));

  const res = await stream();
  assert.equal(res.status, 400, `answered ${res.status}`);
  assert.equal(res.body.code, ERROR_CODES.DOCUMENT_UNREADABLE);
  assert.notEqual(res.body.code, ERROR_CODES.UNVIEWABLE_TEXT_FORMAT,
    "a .docx is a viewable format; only this copy of it is unreadable");
});

// The guard is asked only of documents. A recording's extension is not in the
// viewable list and never will be, and asking would refuse every lecture.
test("a recording is not asked whether it is a viewable document", async () => {
  givenMedia(givenFile("lecture.mp3", "audio bytes"), "audio");

  const res = await stream();
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /audio\/mpeg/);
});

// ── B7 · Hebrew that arrives as Hebrew ──────────────────────────────────────

// text/plain names no encoding, and a browser handed one without a charset does
// not guess UTF-8. Every Hebrew .txt in the archive rendered as mojibake.
test("a UTF-8 text file is served as UTF-8, and says so", async () => {
  givenMedia(givenFile("sefer.txt", Buffer.from("ואמר רבי יוחנן", "utf-8")));

  const res = await stream();
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /charset=utf-8/i);
  assert.equal(res.text, "ואמר רבי יוחנן");
});

// The half that a bare `; charset=utf-8` would have made WORSE: declaring UTF-8
// over windows-1255 bytes turns an occasional mojibake into a guaranteed one.
// The bytes are decoded and re-encoded, so the header is true because the body
// was made true.
test("a windows-1255 text file is converted rather than mislabelled", async () => {
  // "שלום" in windows-1255: the Hebrew letters live at 0xE0..0xFA.
  const legacy = Buffer.from([0xf9, 0xec, 0xe5, 0xed]);
  givenMedia(givenFile("legacy.txt", legacy));

  const res = await stream();
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /charset=utf-8/i);
  assert.equal(res.text, "שלום", "the legacy bytes were decoded, not passed through");
});

// A BOM is a real answer about the encoding and must not survive into the text —
// it would show up as a stray character at the top of the reader.
test("a byte-order mark is consumed rather than served", async () => {
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("בראשית", "utf-8")]);
  givenMedia(givenFile("bom.txt", withBom));

  const res = await stream();
  assert.equal(res.text, "בראשית");
});

// ── The route is navigated to by a frame now, not fetched by axios ──────────
//
// TextViewer points an <iframe> straight at this URL, so a failure is RENDERED
// rather than parsed. A JSON body displayed as text inside the reader looks like
// the document, which is worse than an error.

const asBrowser = () =>
  request(app).get("/api/media/7/stream")
    .set("Cookie", `token=${token}`)
    .set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");

test("a browser asking for a page gets words, not JSON", async () => {
  givenMedia(givenFile("old.doc", "not a zip"));

  const res = await asBrowser();
  assert.equal(res.status, 400);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.match(res.text, /לא ניתן להציג/);
  assert.doesNotMatch(res.text, /UNVIEWABLE_TEXT_FORMAT/, "no machine code on a page a person reads");
});

// A corrupt .docx passes the viewable check — the format is fine, this copy is
// not — so it is the one failure that reaches the frame after it has loaded.
test("a corrupt document explains itself in the frame", async () => {
  givenMedia(givenFile("modern.docx", "not really a zip"));

  const res = await asBrowser();
  assert.equal(res.status, 400);
  assert.match(res.text, /פגום|בסיסמה/);
});

// Anything that is not a browser keeps the JSON contract it was written against.
test("axios still gets JSON with the code on it", async () => {
  givenMedia(givenFile("old.doc", "not a zip"));

  const res = await request(app).get("/api/media/7/stream")
    .set("Cookie", `token=${token}`)
    .set("Accept", "application/json, text/plain, */*");

  assert.match(res.headers["content-type"], /application\/json/);
  assert.equal(res.body.code, ERROR_CODES.UNVIEWABLE_TEXT_FORMAT);
});

// The DB row outliving the file on disk is a real case, and it used to reach the
// reader as a JSON 404 rendered as text.
test("a file missing from disk is a page too", async () => {
  givenMedia("local/does-not-exist.pdf");

  const res = await asBrowser();
  assert.equal(res.status, 404);
  assert.match(res.text, /לא נמצא/);
});
