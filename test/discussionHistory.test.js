import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import {
  listConversations, getConversationById, resumeConversation, HISTORY_PAGE,
} from "../services/discussion/conversations.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// The history of the "דיון עם AI" chat: a reader's earlier conversations on a
// lesson. It is the one place a conversation id comes from the request, so what
// is protected above all is that the id is never enough on its own — another
// reader's conversation must be exactly as missing as one that does not exist.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const SCOPE = { courses: null, drafts: null };
const LESSON = { is_published: true, course_id: null, uploader_id: 9 };
const MINE = { id: 17, media_id: 42, created_at: "t0", updated_at: "t1" };

// `owned` — what the ownership-filtered lookup finds (none = not the caller's).
const historyDb = ({ lesson = LESSON, owned = [MINE], list = [], messages = [] } = {}) =>
  stubPoolQuery(pool, (text) => {
    if (/FROM media_items/i.test(text)) return { rows: lesson ? [lesson] : [] };
    if (/UPDATE ai_conversations/i.test(text)) return { rows: owned };
    if (/GROUP BY c\.id/i.test(text)) return { rows: list };
    if (/FROM ai_conversations/i.test(text)) return { rows: owned };
    if (/FROM ai_messages/i.test(text)) return { rows: messages };
    return { rows: [] };
  });

const find = (stub, re) => stub.calls.find((c) => re.test(c.text));

test("the list is the caller's conversations on this lesson, with something in them", async () => {
  const stub = historyDb({ list: [{ id: 17, questions: 3, first_question: "מה העיקר?" }] });
  try {
    const rows = await listConversations(7, 42, SCOPE);
    assert.equal(rows[0].first_question, "מה העיקר?");
    const call = find(stub, /GROUP BY c\.id/);
    assert.match(call.text, /c\.user_id = \$1 AND c\.media_id = \$2/);
    assert.deepEqual(call.params, [7, 42]);
    // An INNER join on the messages: a conversation never asked in is not history.
    assert.match(call.text, /\bJOIN ai_messages m ON m\.conversation_id = c\.id/);
    assert.match(call.text, /ORDER BY c\.updated_at DESC/);
    assert.match(call.text, new RegExp(`LIMIT ${HISTORY_PAGE}`));
  } finally {
    stub.restore();
  }
});

test("opening a conversation asks for it together with the caller and the lesson", async () => {
  const stub = historyDb({ messages: [{ id: 1, role: "user", content: "שאלה" }] });
  try {
    const result = await getConversationById(7, 42, 17, SCOPE);
    assert.equal(result.conversation.id, 17);
    assert.equal(result.messages.length, 1);
    const lookup = find(stub, /FROM ai_conversations/);
    assert.match(lookup.text, /id = \$1 AND user_id = \$2 AND media_id = \$3/);
    assert.deepEqual(lookup.params, [17, 7, 42]);
  } finally {
    stub.restore();
  }
});

// The point of the whole test file.
test("another reader's conversation is not found, and none of it is read", async () => {
  const stub = historyDb({ owned: [], messages: [{ id: 1, role: "user", content: "סוד" }] });
  try {
    await assert.rejects(() => getConversationById(7, 42, 99, SCOPE), { statusCode: 404, code: "NOT_FOUND" });
    assert.equal(stub.calls.some((c) => /FROM ai_messages/i.test(c.text)), false, "its messages are never selected");
  } finally {
    stub.restore();
  }
});

test("resuming moves the conversation forward — only if it is the caller's", async () => {
  const stub = historyDb();
  try {
    const result = await resumeConversation(7, 42, 17, SCOPE);
    assert.equal(result.conversation.id, 17);
    const update = find(stub, /UPDATE ai_conversations/);
    assert.match(update.text, /SET updated_at = NOW\(\)/);
    assert.match(update.text, /WHERE id = \$1 AND user_id = \$2 AND media_id = \$3/);
  } finally {
    stub.restore();
  }

  const other = historyDb({ owned: [] });
  try {
    await assert.rejects(() => resumeConversation(7, 42, 99, SCOPE), { statusCode: 404 });
  } finally {
    other.restore();
  }
});

test("a lesson the caller may no longer see hides its history too", async () => {
  const stub = historyDb({ lesson: { ...LESSON, course_id: 5 }, list: [{ id: 17 }] });
  try {
    await assert.rejects(() => listConversations(7, 3, { courses: [], drafts: [] }), { statusCode: 404 });
    assert.equal(stub.calls.some((c) => /ai_conversations|ai_messages/i.test(c.text)), false);
  } finally {
    stub.restore();
  }
});

// ── Over HTTP ───────────────────────────────────────────────────────────────

const app = createApp();
const STUDENT = { id: 7, email: "s@example.com", role: "student" };
const token = jwt.sign(STUDENT, process.env.JWT_SECRET, { expiresIn: "1h" });

const httpDb = (owned) =>
  stubPoolQuery(pool, (text, params) => {
    if (/FROM users/i.test(text)) return { rows: [STUDENT] };
    if (/FROM enrollments/i.test(text)) return { rows: [] };
    if (/FROM media_items/i.test(text)) return { rows: [LESSON] };
    if (/ai_conversations/i.test(text)) return { rows: owned, params };
    return { rows: [] };
  });

test("the user in the lookup is the session's, whatever the request says", async () => {
  const stub = httpDb([MINE]);
  try {
    const res = await request(app).get("/api/discussion/42/conversations/17?userId=1").set("Cookie", `token=${token}`);
    assert.equal(res.status, 200);
    const lookup = stub.calls.find((c) => /FROM ai_conversations/i.test(c.text));
    assert.equal(lookup.params[1], 7);
  } finally {
    stub.restore();
  }
});

test("a malformed conversation id is a 400, before the database", async () => {
  const stub = httpDb([MINE]);
  try {
    const res = await request(app).get("/api/discussion/42/conversations/abc").set("Cookie", `token=${token}`);
    assert.equal(res.status, 400);
    assert.equal(stub.calls.some((c) => /ai_conversations/i.test(c.text)), false);
  } finally {
    stub.restore();
  }
});

test("someone else's conversation answers 404 over HTTP", async () => {
  const stub = httpDb([]);
  try {
    const open = await request(app).get("/api/discussion/42/conversations/99").set("Cookie", `token=${token}`);
    assert.equal(open.status, 404);
    const resume = await request(app).post("/api/discussion/42/conversations/99/resume").set("Cookie", `token=${token}`);
    assert.equal(resume.status, 404);
  } finally {
    stub.restore();
  }
});
