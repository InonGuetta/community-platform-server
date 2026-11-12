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

// A lecturer's page (PRD ATTR-10, ARCH-5): the header above their lessons,
// counted over exactly what the caller may see.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();
const STUDENT = { id: 13, email: "s@example.com", role: "student", is_active: true };
const cookie = `token=${jwt.sign({ id: STUDENT.id, email: STUDENT.email, role: STUDENT.role }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;

const PROFILE = {
  name: "הרב כהן", media_count: 5, video_count: 2, audio_count: 2, text_count: 1,
  total_seconds: 9000, latest_at: "2026-11-01T10:00:00Z", courses: [{ id: 4, title: "גמרא" }],
};

const ask = async (name, profile = PROFILE) => {
  const stub = stubPoolQuery(pool, (text) => {
    if (/creator_name = \$3/.test(text)) return { rows: profile ? [profile] : [] };
    if (/FROM users/i.test(text)) return { rows: [STUDENT] };
    if (/FROM enrollments/i.test(text)) return { rows: [{ course_id: 4 }] };
    return { rows: [] };
  });
  try {
    const res = await request(app).get(`/api/media/creators/${encodeURIComponent(name)}`).set("Cookie", cookie);
    return { res, calls: stub.calls };
  } finally {
    stub.restore();
  }
};

test("answers with the lecturer's totals, for a Hebrew name in the path", async () => {
  const { res, calls } = await ask("הרב כהן");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, PROFILE);
  const query = calls.find((c) => /creator_name = \$3/.test(c.text));
  assert.equal(query.params[2], "הרב כהן");
});

// The same predicate as the listing: a student enrolled in course 4 is counted
// over published lessons in it and the general library, nothing else.
test("counts only what the caller may see", async () => {
  const { calls } = await ask("הרב כהן");
  const query = calls.find((c) => /creator_name = \$3/.test(c.text));
  assert.match(query.text, /is_published/);
  assert.deepEqual(query.params[0], [4]);
});

test("a name with nothing visible under it is a 404, like one never used", async () => {
  assert.equal((await ask("אין כזה", null)).res.status, 404);
});

// "כללי" means nobody was named; it is not a person with a page.
test("the unattributed placeholder has no page, and is not even looked up", async () => {
  const { res, calls } = await ask("כללי");
  assert.equal(res.status, 404);
  assert.equal(calls.some((c) => /creator_name = \$3/.test(c.text)), false);
});
