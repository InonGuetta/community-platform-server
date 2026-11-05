import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { LOCAL_UPLOAD_DIR } from "../lib/storage.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// A lesson its manager made public (PRD COM-3b, COM-4, migration 046): opened
// with no session at all, only while public AND published, and with no more
// than a guest page needs.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

const LESSON = {
  id: 7, title: "פרשת כי תבא", description: "שיעור", media_type: "audio", duration_seconds: 600,
  creator_name: "הרב כהן", thumbnail_url: null, created_at: "2026-11-01T10:00:00Z",
  s3_key: "local/never-sent.mp3", course_title: "פרשת השבוע", ai_summary: "על הבאת ביכורים בשמחה.", ai_key_points: ["שמחה"],
};

// Answers the public read with `row` (or nothing), and anything else empty.
const db = (row) =>
  stubPoolQuery(pool, (text) => (/m\.is_public AND m\.is_published/.test(text) ? { rows: row ? [row] : [] } : { rows: [] }));

test("a public lesson opens with no session, without its storage key", async () => {
  const stub = db(LESSON);
  try {
    const res = await request(app).get("/api/public/media/7");
    assert.equal(res.status, 200);
    assert.equal(res.body.title, "פרשת כי תבא");
    assert.equal(res.body.ai_summary, "על הבאת ביכורים בשמחה.");
    assert.equal("s3_key" in res.body, false);
    // Public and published, both, on every read.
    assert.match(stub.calls[0].text, /m\.is_public AND m\.is_published/);
  } finally {
    stub.restore();
  }
});

test("any other lesson is the same 404 as one that does not exist", async () => {
  const stub = db(null);
  try {
    for (const path of ["/api/public/media/7", "/api/public/media/7/stream"]) {
      const res = await request(app).get(path);
      assert.equal(res.status, 404, path);
      assert.equal(res.body.code, "MEDIA_NOT_FOUND");
    }
  } finally {
    stub.restore();
  }
});

test("the recording streams to a guest, ranges and all", async () => {
  const name = `test-public-${randomBytes(4).toString("hex")}.mp3`;
  fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOCAL_UPLOAD_DIR, name), Buffer.from("0123456789"));
  const stub = db({ ...LESSON, s3_key: `local/${name}` });
  try {
    const res = await request(app).get("/api/public/media/7/stream").set("Range", "bytes=2-5");
    assert.equal(res.status, 206);
    assert.equal(res.headers["content-range"], "bytes 2-5/10");
    assert.equal(Buffer.from(res.body).toString(), "2345");
  } finally {
    stub.restore();
    fs.rmSync(path.join(LOCAL_UPLOAD_DIR, name), { force: true });
  }
});

// WhatsApp reads Open Graph tags from the HTML; it runs no JavaScript.
test("the share link carries a preview of the lesson and sends a person on to the guest page", async () => {
  const stub = db({ ...LESSON, title: "<script>alert(1)</script> ביכורים" });
  try {
    const res = await request(app).get("/api/public/share/7");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.match(res.text, /<meta property="og:title" content="&lt;script&gt;alert\(1\)&lt;\/script&gt; ביכורים · הרב כהן">/);
    assert.match(res.text, /<meta property="og:description" content="על הבאת ביכורים בשמחה\.">/);
    assert.match(res.text, /og:image" content="http:\/\/localhost:5173\/icons\/icon-512\.png"/);
    assert.match(res.text, /http-equiv="refresh" content="0; url=http:\/\/localhost:5173\/l\/7"/);
    assert.doesNotMatch(res.text, /<script>/);
  } finally {
    stub.restore();
  }
});

test("the share link of a lesson that is not public names nothing", async () => {
  const stub = db(null);
  try {
    const res = await request(app).get("/api/public/share/7");
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /כי תבא|הרב כהן/);
    assert.match(res.text, /og:title" content="שיעור בפלטפורמת הקהילה"/);
  } finally {
    stub.restore();
  }
});

// ── Making a lesson public ──────────────────────────────────────────────────

const OWNER = { id: 10, email: "o@example.com", role: "lecturer", is_active: true };
const OTHER = { id: 11, email: "x@example.com", role: "lecturer", is_active: true };
const cookieFor = (u) => `token=${jwt.sign({ id: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
const ITEM = { id: 7, title: "ש", uploader_id: OWNER.id, is_published: true, course_id: null, media_type: "audio" };

const asCaller = (caller) =>
  stubPoolQuery(pool, (text) => {
    if (/FROM users/.test(text) && !/media_items/.test(text)) return { rows: [caller] };
    return { rows: [ITEM] };
  });

test("only the lesson's manager may make it public", async () => {
  const other = asCaller(OTHER);
  try {
    const res = await request(app).put("/api/media/update/7").set("Cookie", cookieFor(OTHER)).send({ isPublic: true });
    assert.equal(res.status, 403);
    assert.equal(other.calls.some((c) => /UPDATE media_items SET/.test(c.text)), false);
  } finally {
    other.restore();
  }
  const owner = asCaller(OWNER);
  try {
    const res = await request(app).put("/api/media/update/7").set("Cookie", cookieFor(OWNER)).send({ isPublic: true });
    assert.equal(res.status, 200);
    const update = owner.calls.find((c) => /UPDATE media_items SET/.test(c.text));
    assert.match(update.text, /is_public = COALESCE\(\$12, is_public\)/);
    assert.equal(update.params[11], true);
  } finally {
    owner.restore();
  }
});

test("a malformed switch is refused", async () => {
  const owner = asCaller(OWNER);
  try {
    const res = await request(app).put("/api/media/update/7").set("Cookie", cookieFor(OWNER)).send({ isPublic: "yes please" });
    assert.equal(res.status, 400);
  } finally {
    owner.restore();
  }
});
