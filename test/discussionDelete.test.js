import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import {
  deleteConversation, listConversations, getConversationById, resumeConversation,
  getLatestConversation, countQuestionsToday,
} from "../services/discussion/conversations.js";
import { questionQuota, DAILY_QUESTION_LIMIT } from "../services/discussion/chat.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// Deleting a conversation from the "דיון עם AI" history (migration 034), and
// the quota line under the chat. The two meet in one place: a deletion must
// erase what was written without refunding what was asked.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const SCOPE = { courses: null, drafts: null };
const LESSON = { is_published: true, course_id: null, uploader_id: 9 };

const deleteDb = ({ lesson = LESSON, gone = [{ id: 17 }] } = {}) =>
  stubPoolQuery(pool, (text) => {
    if (/FROM media_items/i.test(text)) return { rows: lesson ? [lesson] : [] };
    if (/WITH gone AS/i.test(text)) return { rows: gone };
    if (/COUNT\(\*\)::int AS n/i.test(text)) return { rows: [{ n: 12 }] };
    return { rows: [] };
  });

test("a deletion is one statement: marked deleted, and every message emptied", async () => {
  const stub = deleteDb();
  try {
    assert.deepEqual(await deleteConversation(7, 42, 17, SCOPE), { deleted: true, id: 17 });
    const writes = stub.calls.filter((c) => /UPDATE/i.test(c.text));
    assert.equal(writes.length, 1, "no moment at which it is hidden but still holds the text");
    const [call] = writes;
    assert.match(call.text, /SET deleted_at = NOW\(\)/);
    assert.match(call.text, /SET content = '', citations = '\[\]'::jsonb/);
    // The ownership test is in the WHERE — the id alone reaches nothing.
    assert.match(call.text, /WHERE id = \$1 AND user_id = \$2 AND media_id = \$3 AND deleted_at IS NULL/);
    assert.deepEqual(call.params, [17, 7, 42]);
    // Rows are kept: the quota counts them.
    assert.equal(stub.calls.some((c) => /DELETE FROM/i.test(c.text)), false);
  } finally {
    stub.restore();
  }
});

test("another reader's conversation, or one already deleted, is a 404", async () => {
  const stub = deleteDb({ gone: [] });
  try {
    await assert.rejects(() => deleteConversation(7, 42, 99, SCOPE), { statusCode: 404, code: "NOT_FOUND" });
  } finally {
    stub.restore();
  }
});

test("a lesson the caller may no longer see cannot be deleted in either", async () => {
  const stub = deleteDb({ lesson: { ...LESSON, course_id: 5 } });
  try {
    await assert.rejects(() => deleteConversation(7, 3, 17, { courses: [], drafts: [] }), { statusCode: 404 });
    assert.equal(stub.calls.some((c) => /ai_conversations/i.test(c.text)), false);
  } finally {
    stub.restore();
  }
});

// Every way back to a conversation must step over a deleted one.
test("a deleted conversation is gone from every read of it", async () => {
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM media_items/i.test(text)) return { rows: [LESSON] };
    if (/ai_conversations/i.test(text)) return { rows: [{ id: 17 }] };
    return { rows: [] };
  });
  try {
    await getLatestConversation(7, 42, SCOPE);
    await listConversations(7, 42, SCOPE);
    await getConversationById(7, 42, 17, SCOPE);
    await resumeConversation(7, 42, 17, SCOPE);
    const reads = stub.calls.filter((c) => /ai_conversations/i.test(c.text));
    assert.equal(reads.length, 4);
    for (const call of reads) assert.match(call.text, /deleted_at IS NULL/, call.text);
  } finally {
    stub.restore();
  }
});

// The reason the rows stay.
test("the quota still counts the questions of a deleted conversation", async () => {
  const stub = deleteDb();
  try {
    await countQuestionsToday(7);
    const count = stub.calls.find((c) => /COUNT\(\*\)::int AS n/i.test(c.text));
    assert.doesNotMatch(count.text, /deleted_at/);
  } finally {
    stub.restore();
  }
});

test("the quota line: what is left today, and nothing for a role it does not bind", async () => {
  const stub = deleteDb();
  try {
    assert.deepEqual(await questionQuota({ id: 7, role: "student" }), { limit: DAILY_QUESTION_LIMIT, remaining: DAILY_QUESTION_LIMIT - 12 });
    const calls = stub.calls.length;
    assert.equal(await questionQuota({ id: 1, role: "admin" }), null);
    assert.equal(await questionQuota({ id: 2, role: "lecturer" }), null);
    assert.equal(stub.calls.length, calls, "nothing is counted for them");
  } finally {
    stub.restore();
  }

  const over = stubPoolQuery(pool, () => ({ rows: [{ n: DAILY_QUESTION_LIMIT + 3 }] }));
  try {
    assert.equal((await questionQuota({ id: 7, role: "student" })).remaining, 0, "never negative");
  } finally {
    over.restore();
  }
});

// ── Over HTTP ───────────────────────────────────────────────────────────────

const app = createApp();
const STUDENT = { id: 7, email: "s@example.com", role: "student" };
const token = jwt.sign(STUDENT, process.env.JWT_SECRET, { expiresIn: "1h" });

const httpDb = (gone) =>
  stubPoolQuery(pool, (text) => {
    if (/FROM users/i.test(text)) return { rows: [STUDENT] };
    if (/FROM enrollments/i.test(text)) return { rows: [] };
    if (/FROM media_items/i.test(text)) return { rows: [LESSON] };
    if (/WITH gone AS/i.test(text)) return { rows: gone };
    if (/COUNT\(\*\)::int AS n/i.test(text)) return { rows: [{ n: 3 }] };
    return { rows: [] };
  });

test("DELETE answers 200 for the caller's own, with the session's user in the WHERE", async () => {
  const stub = httpDb([{ id: 17 }]);
  try {
    const res = await request(app).delete("/api/discussion/42/conversations/17").set("Cookie", `token=${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { deleted: true, id: 17 });
    assert.equal(stub.calls.find((c) => /WITH gone AS/i.test(c.text)).params[1], 7);
  } finally {
    stub.restore();
  }
});

test("DELETE of someone else's is a 404, and needs a session at all", async () => {
  const stub = httpDb([]);
  try {
    const res = await request(app).delete("/api/discussion/42/conversations/99").set("Cookie", `token=${token}`);
    assert.equal(res.status, 404);
    const anonymous = await request(app).delete("/api/discussion/42/conversations/17");
    assert.equal(anonymous.status, 401);
  } finally {
    stub.restore();
  }
});

test("the conversation comes with what is left of the quota", async () => {
  const stub = httpDb([]);
  try {
    const res = await request(app).get("/api/discussion/42/conversation").set("Cookie", `token=${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.quota, { limit: DAILY_QUESTION_LIMIT, remaining: DAILY_QUESTION_LIMIT - 3 });
  } finally {
    stub.restore();
  }
});
