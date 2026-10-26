import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { prepareAsk, DAILY_QUESTION_LIMIT } from "../services/discussion/chat.js";
import { countQuestionsToday } from "../services/discussion/conversations.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// The daily question quota of the "דיון עם AI" chat (PRD ASK-5). A question on
// a large book costs ~$0.15–0.20; the per-minute rate limit put no ceiling on
// a day.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const LESSON = { is_published: true, course_id: null, uploader_id: 9, title: "t", creator_name: "c", media_type: "video" };
const SCOPE = { courses: null, drafts: null };
const noDeps = { answer: async () => "", answerStream: async function* () {}, rewrite: async () => "", search: async () => [] };

// Answers the visibility lookup and the quota count; records what was asked.
const quotaDb = (answered) =>
  stubPoolQuery(pool, (text) => {
    if (/COUNT\(\*\)::int AS n[\s\S]*FROM ai_messages/i.test(text)) return { rows: [{ n: answered }] };
    if (/FROM media_items/i.test(text)) return { rows: [LESSON] };
    if (/FROM transcript_chunks/i.test(text)) return { rows: [{ id: 1, chunk_index: 0, start_time: 0, content: "x" }] };
    if (/FROM ai_conversations/i.test(text)) return { rows: [{ id: 17 }] };
    return { rows: [] };
  });

const ask = (user) => prepareAsk({ user, mediaId: 42, question: "מה העיקר?", scope: SCOPE, deps: noDeps });

test("a student under the limit may ask", async () => {
  const stub = quotaDb(DAILY_QUESTION_LIMIT - 1);
  try {
    await ask({ id: 7, role: "student" });
  } finally {
    stub.restore();
  }
});

test("a student at the limit is refused with 429, before any lesson text is read", async () => {
  const stub = quotaDb(DAILY_QUESTION_LIMIT);
  try {
    await assert.rejects(() => ask({ id: 7, role: "student" }), { statusCode: 429, code: "AI_DAILY_LIMIT" });
    assert.equal(stub.calls.some((c) => /FROM transcript_chunks/i.test(c.text)), false, "nothing is read, nothing is paid for");
    assert.equal(stub.calls.some((c) => /ai_conversations\s*\(|INSERT/i.test(c.text)), false, "no conversation is opened");
  } finally {
    stub.restore();
  }
});

test("lecturers and admins are not counted at all", async () => {
  for (const role of ["lecturer", "admin"]) {
    const stub = quotaDb(DAILY_QUESTION_LIMIT * 10);
    try {
      await ask({ id: 1, role });
      assert.equal(stub.calls.some((c) => /COUNT\(\*\)::int AS n/i.test(c.text)), false, `${role}: not even queried`);
    } finally {
      stub.restore();
    }
  }
});

test("a lesson the caller may not see is still a 404, not a quota message", async () => {
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM media_items/i.test(text)) return { rows: [{ ...LESSON, course_id: 5 }] };
    return { rows: [{ n: DAILY_QUESTION_LIMIT }] };
  });
  try {
    await assert.rejects(
      () => prepareAsk({ user: { id: 7, role: "student" }, mediaId: 3, question: "x", scope: { courses: [], drafts: [] }, deps: noDeps }),
      { statusCode: 404 }
    );
  } finally {
    stub.restore();
  }
});

test("the count is the caller's own questions, since midnight in Jerusalem", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [{ n: 3 }] }));
  try {
    assert.equal(await countQuestionsToday(7), 3);
    const [call] = stub.calls;
    assert.deepEqual(call.params, [7]);
    assert.match(call.text, /c\.user_id = \$1/);
    assert.match(call.text, /m\.role = 'user'/, "answers are not questions");
    assert.match(call.text, /'Asia\/Jerusalem'/);
  } finally {
    stub.restore();
  }
});

// Over the streaming route: the refusal must come before the stream opens, as
// JSON with its status, so the client can say "come back tomorrow".
const app = createApp();
const token = jwt.sign({ id: 7, email: "s@example.com", role: "student" }, process.env.JWT_SECRET, { expiresIn: "1h" });

test("the streaming route answers the quota as a JSON 429", async () => {
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM users/i.test(text)) return { rows: [{ id: 7, email: "s@example.com", role: "student" }] };
    if (/FROM enrollments/i.test(text)) return { rows: [] };
    if (/COUNT\(\*\)::int AS n/i.test(text)) return { rows: [{ n: DAILY_QUESTION_LIMIT }] };
    if (/FROM media_items/i.test(text)) return { rows: [LESSON] };
    return { rows: [] };
  });
  try {
    const res = await request(app).post("/api/discussion/42/messages/stream").set("Cookie", `token=${token}`).send({ question: "x" });
    assert.equal(res.status, 429);
    assert.equal(res.body.code, "AI_DAILY_LIMIT");
    assert.match(res.headers["content-type"], /json/);
  } finally {
    stub.restore();
  }
});
