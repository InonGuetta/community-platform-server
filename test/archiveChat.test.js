import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery, stubPoolConnect } from "./setup.js";
import { streamAsk, DAILY_QUESTION_LIMIT } from "../services/discussion/chat.js";
import {
  pickPassages, searchArchive, prepareArchiveAsk, archivePassageLabel, archiveCitation,
  ARCHIVE_PASSAGES, PER_LESSON_MAX, ARCHIVE_NOTHING_FOUND, ARCHIVE_UNGROUNDED,
} from "../services/discussion/archive.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// The chat over the whole archive (PRD ASK-2). No OpenAI call is made: the
// embedding, rerank, rewrite and answer are injected, and the pool is stubbed.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const STUDENT = { id: 5, role: "student" };
const SCOPE = { courses: [3], drafts: null };
const CONVERSATION = { id: 70, media_id: null, created_at: "t0", updated_at: "t1" };

const passage = (mediaId, i, extra = {}) => ({
  id: mediaId * 100 + i, media_id: mediaId, chunk_index: i,
  start_time: i * 600, end_time: i * 600 + 600, page_number: null, char_start: null,
  content: `קטע ${i} בשיעור ${mediaId}`,
  media_title: `שיעור ${mediaId}`, creator_name: `הרב ${mediaId}`, media_type: "audio",
  ...extra,
});

// ── Choosing passages ───────────────────────────────────────────────────────

test("no one lesson fills the answer, and passages are grouped lesson by lesson in reading order", () => {
  const ranked = [
    passage(1, 5), passage(1, 2), passage(2, 7), passage(1, 9), passage(1, 1), passage(3, 4), passage(2, 3),
  ];
  const picked = pickPassages(ranked);
  assert.equal(picked.filter((p) => p.media_id === 1).length, PER_LESSON_MAX);
  // Lesson 1 had the best passage, so it comes first; then 2, then 3.
  assert.deepEqual(picked.map((p) => [p.media_id, p.chunk_index]), [
    [1, 2], [1, 5], [1, 9], [2, 3], [2, 7], [3, 4],
  ]);
});

test("at most ARCHIVE_PASSAGES are kept", () => {
  const ranked = Array.from({ length: 20 }, (_, i) => passage(i + 1, 0));
  assert.equal(pickPassages(ranked).length, ARCHIVE_PASSAGES);
});

// ── Retrieval: visibility inside every ranking ──────────────────────────────

test("the hybrid search applies the caller's visibility inside both rankings, with their scope", async () => {
  const conn = stubPoolConnect(pool, (text) => (/SELECT/i.test(text) && /fused/i.test(text) ? { rows: [passage(1, 0)] } : { rows: [] }));
  try {
    const seenRerank = [];
    const rows = await searchArchive("מה זו תשובה", SCOPE, {
      embed: async () => [0.1, 0.2],
      rerank: async (q, r, limit) => { seenRerank.push(limit); return r; },
    });
    const sql = conn.calls.find((c) => /fused/i.test(c.text));
    assert.ok(sql, "the hybrid statement ran");
    // Once in kw, once in vec — before each LIMIT, not after the fusion.
    assert.equal(sql.text.match(/is_published/g)?.length, 2);
    assert.deepEqual(sql.params.slice(2), [SCOPE.courses, SCOPE.drafts]);
    assert.ok(conn.calls.some((c) => /SET LOCAL hnsw\.ef_search/.test(c.text)), "the vector scan is widened");
    assert.equal(rows.length, 1);
    assert.deepEqual(seenRerank, [ARCHIVE_PASSAGES * 2]);
  } finally {
    conn.restore();
  }
});

test("with no embedding the archive is still searched by keyword, with the same visibility", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [passage(2, 1)] }));
  try {
    const rows = await searchArchive("תשובה", SCOPE, {
      embed: async () => { throw new Error("OpenAI down"); },
      rerank: async () => { throw new Error("must not rerank without an embedding"); },
    });
    assert.equal(rows.length, 1);
    assert.match(stub.calls[0].text, /is_published/);
    assert.deepEqual(stub.calls[0].params.slice(2), [SCOPE.courses, SCOPE.drafts]);
  } finally {
    stub.restore();
  }
});

// ── Labels and citations name the lesson ────────────────────────────────────

test("a passage is labelled, and a citation stored, with its lesson and lecturer", () => {
  const p = passage(4, 2);
  assert.equal(archivePassageLabel(p), "«שיעור 4», הרב 4, 20:00");
  assert.equal(archivePassageLabel({ ...p, start_time: null, page_number: 12 }), "«שיעור 4», הרב 4, עמ' 12");
  assert.deepEqual(archiveCitation(p, 3), {
    n: 3, chunk_index: 2, start_time: 1200, end_time: 1800, page_number: null, char_start: null,
    quote: p.content, media_id: 4, media_title: "שיעור 4", creator_name: "הרב 4", media_type: "audio",
  });
});

// ── The whole round, through the lesson chat's stream ───────────────────────

const flowDb = ({ conversations = [CONVERSATION], asked = 0 } = {}) => {
  const stored = [];
  const stub = stubPoolQuery(pool, (text, params) => {
    if (/COUNT\(\*\)::int AS n/i.test(text)) return { rows: [{ n: asked }] };
    if (/INSERT INTO ai_messages/i.test(text)) {
      const row = { id: 900 + stored.length, role: params[1], content: params[2], citations: JSON.parse(params[3]) };
      stored.push(row);
      return { rows: [row] };
    }
    if (/INSERT INTO ai_conversations/i.test(text)) return { rows: [CONVERSATION] };
    if (/FROM ai_conversations/i.test(text)) return { rows: conversations };
    return { rows: [] };
  });
  return { stub, stored };
};

const fakeDeps = ({ reply = "הרב 1 אמר כך [1], והרב 2 אחרת [2].", hits = [passage(1, 0), passage(2, 0)] } = {}) => {
  const seen = { messages: [], searched: [] };
  return {
    seen,
    deps: {
      answerStream: async function* (messages) { seen.messages.push(messages); yield reply; },
      rewrite: async () => "שאלה מנוסחת",
      search: async (q, scope) => { seen.searched.push({ q, scope }); return hits; },
    },
  };
};

test("an answer cites passages from two lessons, and each stored citation names its lesson", async () => {
  const { stub, stored } = flowDb();
  const { deps, seen } = fakeDeps();
  try {
    const prepared = await prepareArchiveAsk({ user: STUDENT, question: "מה זו תשובה?", scope: SCOPE, deps });
    const result = await streamAsk(prepared, { onDelta: () => {} });
    assert.deepEqual(seen.searched, [{ q: "מה זו תשובה?", scope: SCOPE }]);
    const userTurn = seen.messages[0].at(-1).content;
    assert.match(userTurn, /\[1\] \(«שיעור 1», הרב 1, 0:00\)/);
    assert.match(userTurn, /\[2\] \(«שיעור 2», הרב 2, 0:00\)/);
    const answer = stored[1];
    assert.deepEqual(answer.citations.map((c) => [c.n, c.media_id, c.media_title]), [[1, 1, "שיעור 1"], [2, 2, "שיעור 2"]]);
    assert.equal(result.conversation.id, CONVERSATION.id);
    // The conversation it went into is the caller's archive conversation.
    const read = stub.calls.find((c) => /FROM ai_conversations/i.test(c.text));
    assert.match(read.text, /media_id IS NULL/);
    assert.deepEqual(read.params, [STUDENT.id]);
  } finally {
    stub.restore();
  }
});

test("nothing found in the archive says so for the archive, and asks no model", async () => {
  const { stub, stored } = flowDb();
  const { deps, seen } = fakeDeps({ hits: [] });
  try {
    await streamAsk(await prepareArchiveAsk({ user: STUDENT, question: "x", scope: SCOPE, deps }), { onDelta: () => {} });
    assert.equal(seen.messages.length, 0);
    assert.equal(stored[1].content, ARCHIVE_NOTHING_FOUND);
  } finally {
    stub.restore();
  }
});

test("an uncited answer is withheld, in the archive's words, and nothing of it is shown", async () => {
  const { stub, stored } = flowDb();
  const { deps } = fakeDeps({ reply: "תשובה בלי מקור." });
  try {
    const shown = [];
    await streamAsk(await prepareArchiveAsk({ user: STUDENT, question: "x", scope: SCOPE, deps }), { onDelta: (t) => shown.push(t) });
    assert.deepEqual(shown, []);
    assert.equal(stored[1].content, ARCHIVE_UNGROUNDED);
  } finally {
    stub.restore();
  }
});

test("the daily quota counts the archive with the lessons, and refuses before anything is opened", async () => {
  const { stub } = flowDb({ asked: DAILY_QUESTION_LIMIT });
  const { deps } = fakeDeps();
  try {
    await assert.rejects(
      prepareArchiveAsk({ user: STUDENT, question: "x", scope: SCOPE, deps }),
      { statusCode: 429, code: "AI_DAILY_LIMIT" }
    );
    assert.ok(!stub.calls.some((c) => /INSERT INTO ai_conversations/i.test(c.text)));
  } finally {
    stub.restore();
  }
});

// ── Routes ──────────────────────────────────────────────────────────────────

const app = createApp();
const STUDENT_ROW = { id: 5, email: "s@example.com", role: "student" };
const token = jwt.sign({ id: 5, email: "s@example.com", role: "student" }, process.env.JWT_SECRET, { expiresIn: "1h" });

test("GET /archive/conversation reaches the archive, not the /:mediaId check, and only the caller's", async () => {
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM users/i.test(text)) return { rows: [STUDENT_ROW] };
    if (/COUNT\(\*\)::int AS n/i.test(text)) return { rows: [{ n: 2 }] };
    return { rows: [] };
  });
  try {
    const res = await request(app).get("/api/discussion/archive/conversation").set("Cookie", `token=${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { conversation: null, messages: [], quota: { limit: DAILY_QUESTION_LIMIT, remaining: DAILY_QUESTION_LIMIT - 2 } });
    const read = stub.calls.find((c) => /FROM ai_conversations/i.test(c.text) && /media_id IS NULL/.test(c.text));
    assert.deepEqual(read.params, [5]);
  } finally {
    stub.restore();
  }
});

test("the archive stream refuses a bad question as JSON, before any stream", async () => {
  const stub = stubPoolQuery(pool, (text) => (/FROM users/i.test(text) ? { rows: [STUDENT_ROW] } : { rows: [] }));
  try {
    const res = await request(app).post("/api/discussion/archive/messages/stream").set("Cookie", `token=${token}`).send({ question: " " });
    assert.equal(res.status, 400);
    assert.match(res.headers["content-type"], /json/);
  } finally {
    stub.restore();
  }
});

test("signed out, the archive chat is a 401", async () => {
  const res = await request(app).get("/api/discussion/archive/conversation");
  assert.equal(res.status, 401);
});
