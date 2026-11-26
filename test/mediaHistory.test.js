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

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

// The history (migration 055): every lesson the reader was in, any kind, the
// archive's hero and the "היסטוריה" shelf — and the visit that feeds it.

const app = createApp();
const STUDENT = { id: 3, email: "s@example.com", role: "student", is_active: true };
const tokenFor = (user) =>
  jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "1h" });

const BOOK = { id: 11, title: "ספר", media_type: "text", s3_key: "local/book.pdf", last_seen_at: "2026-11-26T10:00:00Z", last_position_seconds: null };
const VIDEO = { id: 12, title: "וידאו", media_type: "video", s3_key: "videos/v.mp4", last_seen_at: "2026-11-25T10:00:00Z", last_position_seconds: 40 };

const withDb = async (rowsForHistory, run) => {
  const sent = [];
  const db = stubPoolQuery(pool, (text, params) => {
    sent.push({ text, params });
    if (/FROM users/i.test(text)) return { rows: [STUDENT] };
    if (/FROM enrollments/i.test(text)) return { rows: [] };
    if (/media_views/i.test(text) && /SELECT/i.test(text)) return { rows: rowsForHistory };
    if (/FROM media_items/i.test(text) && /id\s*=\s*\$1/i.test(text)) {
      return { rows: [{ id: 11, media_type: "text", is_published: true, course_id: null, uploader_id: 99 }] };
    }
    return { rows: [] };
  });
  try {
    return await run(sent);
  } finally {
    db.restore();
  }
};

test("the history: every kind of lesson, newest first as the query orders it, without a storage key", async () => {
  await withDb([BOOK, VIDEO], async (sent) => {
    const res = await request(app).get("/api/media/history").set("Cookie", `token=${tokenFor(STUDENT)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((item) => [item.id, item.media_type]), [[11, "text"], [12, "video"]]);
    assert.ok(res.body.every((item) => !("s3_key" in item)));

    const query = sent.find(({ text }) => /media_views/i.test(text) && /SELECT/i.test(text));
    assert.ok(query, "the history query was sent");
    // The caller's own visits, and both kinds of visit.
    assert.equal(query.params[0], STUDENT.id);
    assert.match(query.text, /FROM media_views WHERE user_id = \$1/);
    assert.match(query.text, /FROM watch_progress WHERE user_id = \$1/);
    // The visibility rule, as on every read of lessons.
    assert.match(query.text, /is_published/);
    assert.match(query.text, /course_id = ANY\(\$2::int\[\]\)/);
    assert.match(query.text, /ORDER BY s\.last_seen_at DESC/);
  });
});

test("a visit is recorded for the caller, from the session — never from the request", async () => {
  await withDb([], async (sent) => {
    const res = await request(app)
      .post("/api/media/11/view")
      .set("Cookie", `token=${tokenFor(STUDENT)}`)
      .send({ userId: 1 });
    assert.equal(res.status, 204);
    const upsert = sent.find(({ text }) => /INSERT INTO media_views/i.test(text));
    assert.ok(upsert, "the visit was written");
    assert.deepEqual(upsert.params.map(Number), [STUDENT.id, 11]);
    assert.match(upsert.text, /ON CONFLICT \(user_id, media_id\) DO UPDATE SET last_viewed_at = NOW\(\)/);
  });
});

test("the history needs a session", async () => {
  const res = await request(app).get("/api/media/history");
  assert.equal(res.status, 401);
});
