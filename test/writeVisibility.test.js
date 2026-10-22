import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { ERROR_CODES } from "../lib/AppError.js";
import { maskEmail } from "../services/servicesCourses.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// Writes that name a media item — a like, a save, a playlist item — used to
// accept any id. A student could like a draft (counted in like_count, which its
// owner sees), and a missing id failed the FK as a 500 while an existing one
// answered 201: a way to enumerate the archive through endpoints nobody thinks
// of as reads.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

const STUDENT = { id: 3, email: "s@example.com", role: "student", is_active: true };
const token = jwt.sign({ id: 3, email: STUDENT.email, role: "student" }, process.env.JWT_SECRET, {
  expiresIn: "1h",
});

const DRAFT = {
  id: 7, title: "טיוטה", media_type: "audio",
  is_published: false, course_id: null, uploader_id: 1,
};
const PUBLISHED = { ...DRAFT, title: "שיעור", is_published: true };

const capture = (media) => {
  const calls = [];
  stubPoolQuery(pool, (text, params) => {
    calls.push({ text, params });
    if (/FROM users/i.test(text)) return { rows: [STUDENT] };
    if (/FROM media_items m/i.test(text)) return { rows: media ? [media] : [] };
    if (/INSERT INTO likes|INSERT INTO saved_items/i.test(text)) return { rows: [{ media_id: 7 }] };
    return { rows: [] };
  });
  return calls;
};

const wrote = (calls) => calls.some((c) => /INSERT INTO (likes|saved_items)/i.test(c.text));

for (const [name, path] of [["like", "/api/likes"], ["save", "/api/saves"]]) {
  test(`a ${name} on a draft the student cannot see is a 404, and writes nothing`, async () => {
    const calls = capture(DRAFT);
    const res = await request(app).post(path).set("Cookie", `token=${token}`).send({ mediaId: 7 });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, ERROR_CODES.MEDIA_NOT_FOUND);
    assert.equal(wrote(calls), false);
  });

  test(`a ${name} on a missing id is the same 404 as a hidden one`, async () => {
    capture(null);
    const res = await request(app).post(path).set("Cookie", `token=${token}`).send({ mediaId: 7 });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, ERROR_CODES.MEDIA_NOT_FOUND);
  });

  test(`a ${name} on a visible item still works`, async () => {
    const calls = capture(PUBLISHED);
    const res = await request(app).post(path).set("Cookie", `token=${token}`).send({ mediaId: 7 });
    assert.equal(res.status, 201);
    assert.equal(wrote(calls), true);
  });
}

// Clearing a cookie needs no session. Requiring one meant an expired cookie
// answered 401 and was never cleared.
test("logout without a session still clears the cookie", async () => {
  const res = await request(app).post("/api/auth/logout");
  assert.equal(res.status, 200);
  assert.match(String(res.headers["set-cookie"]), /token=;/);
});

test("enrolment search masks the addresses it returns", () => {
  assert.equal(maskEmail("yosef.cohen@gmail.com"), "yo***@gmail.com");
  assert.equal(maskEmail("a@b.co"), "a***@b.co");
  assert.equal(maskEmail(""), "");
});
