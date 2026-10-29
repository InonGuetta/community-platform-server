import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "fs/promises";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import {
  getLatestConversation, startConversation, appendMessage, getRecentMessages,
} from "../services/discussion/conversations.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// The conversation store behind the "דיון עם AI" tab (migration 032).
//
// What is protected here: a conversation is private to its user and reachable
// only through a lesson they may still see. Neither shows up as an error when
// broken — a missing user_id filter simply returns someone else's questions,
// with a 200.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const ADMIN_SCOPE = { courses: null, drafts: null };
const STUDENT_SCOPE = { courses: [], drafts: [] };
const VISIBLE_LESSON = { is_published: true, course_id: null, uploader_id: 9 };
const CONVERSATION = { id: 17, media_id: 42, created_at: "t0", updated_at: "t1" };

// `handlers` answer by table; anything unlisted answers with no rows.
const db = ({ lesson = VISIBLE_LESSON, conversations = [], messages = [], inserted = CONVERSATION } = {}) =>
  stubPoolQuery(pool, (text) => {
    if (/FROM media_items/i.test(text)) return { rows: lesson ? [lesson] : [] };
    if (/INSERT INTO ai_conversations/i.test(text)) return { rows: [inserted] };
    if (/FROM ai_conversations/i.test(text)) return { rows: conversations };
    if (/FROM ai_messages/i.test(text)) return { rows: messages };
    return { rows: [] };
  });

const touches = (stub, re) => stub.calls.filter((c) => re.test(c.text));

// ── Reading ─────────────────────────────────────────────────────────────────

test("the latest conversation is looked up by the caller AND the lesson", async () => {
  const stub = db({ conversations: [CONVERSATION], messages: [{ id: 1, role: "user", content: "שאלה" }] });
  try {
    const result = await getLatestConversation(7, 42, ADMIN_SCOPE);
    assert.equal(result.conversation.id, 17);
    assert.equal(result.messages.length, 1);
    const [lookup] = touches(stub, /FROM ai_conversations/i);
    assert.match(lookup.text, /user_id = \$1 AND media_id = \$2/);
    assert.deepEqual(lookup.params, [7, 42]);
    assert.match(lookup.text, /ORDER BY updated_at DESC/, "the most recently ACTIVE one, not the newest created");
  } finally {
    stub.restore();
  }
});

test("a lesson nobody has asked about yet is an empty tab, not an error", async () => {
  const stub = db();
  try {
    const result = await getLatestConversation(7, 42, ADMIN_SCOPE);
    assert.deepEqual(result, { conversation: null, messages: [] });
    assert.equal(touches(stub, /FROM ai_messages/i).length, 0, "no conversation, nothing to read messages of");
  } finally {
    stub.restore();
  }
});

test("messages come back oldest-first, from the newest page", async () => {
  const stub = db({ conversations: [CONVERSATION] });
  try {
    await getLatestConversation(7, 42, ADMIN_SCOPE);
    const [read] = touches(stub, /FROM ai_messages/i);
    assert.match(read.text, /ORDER BY id DESC\s+LIMIT \$2[\s\S]*\) newest\s+ORDER BY id/);
    assert.equal(read.params[0], 17);
  } finally {
    stub.restore();
  }
});

test("a lesson the caller may no longer see hides their conversation too", async () => {
  // A student who left the course: the rows are theirs, but the lesson is not
  // theirs to open, so neither is a discussion of its text.
  const stub = db({ lesson: { is_published: true, course_id: 5, uploader_id: 9 }, conversations: [CONVERSATION] });
  try {
    await assert.rejects(() => getLatestConversation(7, 3, STUDENT_SCOPE), { statusCode: 404, code: "MEDIA_NOT_FOUND" });
    assert.equal(touches(stub, /ai_conversations|ai_messages/i).length, 0);
  } finally {
    stub.restore();
  }
});

// ── Starting ────────────────────────────────────────────────────────────────

test("starting a conversation creates one for the caller on this lesson", async () => {
  const stub = db();
  try {
    const result = await startConversation(7, 42, ADMIN_SCOPE);
    assert.equal(result.created, true);
    assert.equal(result.conversation.id, 17);
    const [insert] = touches(stub, /INSERT INTO ai_conversations/i);
    assert.deepEqual(insert.params, [7, 42]);
  } finally {
    stub.restore();
  }
});

test("pressing 'שיחה חדשה' twice leaves one empty conversation, not two", async () => {
  // The latest conversation exists and has no messages: it IS the new one.
  const stub = db({ conversations: [CONVERSATION], messages: [] });
  try {
    const result = await startConversation(7, 42, ADMIN_SCOPE);
    assert.equal(result.created, false);
    assert.equal(result.conversation.id, 17);
    assert.equal(touches(stub, /INSERT INTO ai_conversations/i).length, 0);
  } finally {
    stub.restore();
  }
});

test("a conversation that has messages is kept, and a new one starts beside it", async () => {
  const stub = db({ conversations: [CONVERSATION], messages: [{ "?column?": 1 }], inserted: { ...CONVERSATION, id: 18 } });
  try {
    const result = await startConversation(7, 42, ADMIN_SCOPE);
    assert.equal(result.created, true);
    assert.equal(result.conversation.id, 18);
    // A word, so `deleted_at` (migration 034) in every read is not a DELETE.
    assert.equal(touches(stub, /\bDELETE\b/i).length, 0, "the old conversation is history, not garbage");
  } finally {
    stub.restore();
  }
});

test("starting is refused on a lesson the caller may not see, before any write", async () => {
  const stub = db({ lesson: null });
  try {
    await assert.rejects(() => startConversation(7, 999, ADMIN_SCOPE), { statusCode: 404 });
    assert.equal(touches(stub, /INSERT/i).length, 0);
  } finally {
    stub.restore();
  }
});

// ── Writing messages ────────────────────────────────────────────────────────

test("a message and the conversation's updated_at move in one statement", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [{ id: 5, role: "assistant", content: "תשובה", citations: [] }] }));
  try {
    const citations = [{ n: 1, start_time: 754, page_number: null, quote: "..." }];
    await appendMessage(17, { role: "assistant", content: "תשובה", citations });
    assert.equal(stub.calls.length, 1, "two statements could disagree about whether the message exists");
    const [call] = stub.calls;
    assert.match(call.text, /INSERT INTO ai_messages/);
    assert.match(call.text, /UPDATE ai_conversations SET updated_at = NOW\(\) WHERE id = \$1/);
    assert.equal(call.params[3], JSON.stringify(citations), "citations are stored as the snapshot they were given");
  } finally {
    stub.restore();
  }
});

test("a message with no citations stores an empty list, not null", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [{}] }));
  try {
    await appendMessage(17, { role: "user", content: "שאלה" });
    assert.equal(stub.calls[0].params[3], "[]");
  } finally {
    stub.restore();
  }
});

test("the chat's history is bounded by the limit it asks for", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    await getRecentMessages(17, 6);
    assert.deepEqual(stub.calls[0].params, [17, 6]);
  } finally {
    stub.restore();
  }
});

// ── The migration ───────────────────────────────────────────────────────────

test("citations are a snapshot: nothing in 032 references transcript_chunks", async () => {
  // writeChunks deletes and re-inserts every chunk of a lesson on each pipeline
  // run. A reference to it would delete (CASCADE) or strip (SET NULL) every
  // answer's citations the moment a lecturer re-processes the lesson.
  const sql = await readFile(new URL("../db/migrations/032_create_ai_discussions.sql", import.meta.url), "utf8");
  const statements = sql.replace(/--.*$/gm, "");
  assert.match(statements, /CREATE TABLE IF NOT EXISTS ai_conversations/, "the parse found the migration");
  assert.doesNotMatch(statements, /REFERENCES\s+transcript_chunks/i);
  for (const stmt of statements.split(";").filter((s) => /CREATE/i.test(s))) {
    assert.match(stmt, /IF NOT EXISTS/, `not re-runnable: ${stmt.trim().slice(0, 60)}`);
  }
});

// ── Over HTTP ───────────────────────────────────────────────────────────────

const app = createApp();
const STUDENT_ROW = { id: 7, email: "s@example.com", role: "student" };
const token = jwt.sign({ id: 7, email: "s@example.com", role: "student" }, process.env.JWT_SECRET, { expiresIn: "1h" });

test("the conversation is the signed-in user's, whatever the request says", async () => {
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM users/i.test(text)) return { rows: [STUDENT_ROW] };
    if (/FROM enrollments/i.test(text)) return { rows: [] };
    if (/FROM media_items/i.test(text)) return { rows: [VISIBLE_LESSON] };
    return { rows: [] };
  });
  try {
    const res = await request(app)
      .get("/api/discussion/42/conversation?userId=1")
      .set("Cookie", `token=${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual({ conversation: res.body.conversation, messages: res.body.messages }, { conversation: null, messages: [] });
    const [lookup] = stub.calls.filter((c) => /FROM ai_conversations/i.test(c.text));
    assert.equal(lookup.params[0], 7, "the user comes from the session, never from the query");
  } finally {
    stub.restore();
  }
});

test("starting answers 201 when it creates and 200 when it hands back the empty one", async () => {
  const run = async (conversations, messages) => {
    const stub = stubPoolQuery(pool, (text) => {
      if (/FROM users/i.test(text)) return { rows: [STUDENT_ROW] };
      if (/FROM enrollments/i.test(text)) return { rows: [] };
      if (/FROM media_items/i.test(text)) return { rows: [VISIBLE_LESSON] };
      if (/INSERT INTO ai_conversations/i.test(text)) return { rows: [CONVERSATION] };
      if (/FROM ai_conversations/i.test(text)) return { rows: conversations };
      if (/FROM ai_messages/i.test(text)) return { rows: messages };
      return { rows: [] };
    });
    try {
      return await request(app).post("/api/discussion/42/conversation").set("Cookie", `token=${token}`);
    } finally {
      stub.restore();
    }
  };

  const created = await run([], []);
  assert.equal(created.status, 201);
  assert.equal(created.body.conversation.id, 17);
  assert.equal("created" in created.body, false, "the flag is the status code's job, not the body's");

  const reused = await run([CONVERSATION], []);
  assert.equal(reused.status, 200);
});
