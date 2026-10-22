import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import {
  askInLesson, validateAnswer, systemPrompt, HISTORY_MESSAGES, NOTHING_FOUND_ANSWER, UNGROUNDED_ANSWER,
} from "../services/discussion/chat.js";
import { FULL_TEXT_MAX_CHARS, passageLabel } from "../services/discussion/context.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// The "דיון עם AI" chat. No OpenAI call is made: the grounded answer, the
// rewrite and the search are injected, so the real flow — visibility, the
// choice of passages, citation checking, storage — runs against a stubbed pool.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const ADMIN = { id: 1, role: "admin" };
const SCOPE = { courses: null, drafts: null };
const LESSON = {
  is_published: true, course_id: null, uploader_id: 9,
  title: "שיחת הכנה ליום כיפור", creator_name: "הרב דוד כהן", media_type: "video",
};
const CONVERSATION = { id: 17, media_id: 42, created_at: "t0", updated_at: "t1" };

const recording = (i, content = `קטע ${i}`) => ({
  id: 100 + i, chunk_index: i, start_time: i * 600, end_time: i * 600 + 600,
  page_number: null, char_start: null, content,
});

// One stub for the whole flow. `stored` collects what appendMessage wrote.
const flowDb = ({ lesson = LESSON, chunks = [recording(0), recording(1)], conversations = [CONVERSATION], history = [] } = {}) => {
  const stored = [];
  const stub = stubPoolQuery(pool, (text, params) => {
    if (/INSERT INTO ai_messages/i.test(text)) {
      const row = { id: 500 + stored.length, role: params[1], content: params[2], citations: JSON.parse(params[3]) };
      stored.push(row);
      return { rows: [row] };
    }
    if (/INSERT INTO ai_conversations/i.test(text)) return { rows: [CONVERSATION] };
    if (/FROM ai_conversations/i.test(text)) return { rows: conversations };
    if (/FROM ai_messages/i.test(text)) return { rows: history };
    if (/FROM transcript_chunks/i.test(text)) return { rows: chunks };
    if (/FROM media_items/i.test(text)) return { rows: lesson ? [lesson] : [] };
    return { rows: [] };
  });
  return { stub, stored };
};

// Records what each dependency was asked; answers with `reply`.
const fakeDeps = ({ reply = { answer: "הרב אמר כך [1].", citations: [1] }, hits = [], rewritten = "שאלה מנוסחת" } = {}) => {
  const seen = { answer: [], rewrite: [], search: [] };
  return {
    seen,
    deps: {
      answer: async (messages) => { seen.answer.push(messages); if (reply instanceof Error) throw reply; return reply; },
      rewrite: async (history, q) => { seen.rewrite.push({ history, q }); if (rewritten instanceof Error) throw rewritten; return rewritten; },
      search: async (mediaId, q, scope) => { seen.search.push({ mediaId, q, scope }); return hits; },
    },
  };
};

const ask = (deps, question = "מה העיקר?") =>
  askInLesson({ user: ADMIN, mediaId: 42, question, scope: SCOPE, deps });

// ── Choosing the passages ───────────────────────────────────────────────────

test("a short lesson is sent whole, numbered in reading order, with no search", async () => {
  const { stub } = flowDb({ chunks: [recording(0, "פתיחה"), recording(1, "סיום")] });
  const { deps, seen } = fakeDeps();
  try {
    await ask(deps);
    assert.equal(seen.search.length, 0, "nothing to retrieve when the whole lesson fits");
    const userTurn = seen.answer[0].at(-1).content;
    assert.match(userTurn, /\[1\] \(0:00\)\nפתיחה/);
    assert.match(userTurn, /\[2\] \(10:00\)\nסיום/);
    assert.match(userTurn, /שאלה: מה העיקר\?$/);
  } finally {
    stub.restore();
  }
});

test("a long lesson is retrieved, and its passages are put back in reading order", async () => {
  const half = "א".repeat(FULL_TEXT_MAX_CHARS / 2 + 1);
  const { stub } = flowDb({ chunks: [recording(0, half), recording(1, half)] });
  const { deps, seen } = fakeDeps({ hits: [recording(7, "מאוחר"), recording(2, "מוקדם")] });
  try {
    await ask(deps);
    assert.equal(seen.search.length, 1);
    assert.equal(seen.search[0].mediaId, 42);
    assert.equal(seen.search[0].scope, SCOPE, "retrieval runs with the caller's own scope");
    const userTurn = seen.answer[0].at(-1).content;
    assert.ok(userTurn.indexOf("מוקדם") < userTurn.indexOf("מאוחר"), "passage 2 of the lesson before passage 7");
    assert.doesNotMatch(userTurn, /א{100}/, "the whole lesson must not be sent when it does not fit");
  } finally {
    stub.restore();
  }
});

test("a follow-up is made standalone before it is searched for", async () => {
  const big = "א".repeat(FULL_TEXT_MAX_CHARS + 1);
  const history = [{ role: "user", content: "מה זה תשובה?" }, { role: "assistant", content: "חזרה [1]." }];
  const { stub } = flowDb({ chunks: [recording(0, big)], history });
  const { deps, seen } = fakeDeps({ hits: [recording(0, "קטע")], rewritten: "מה אמר הרב על תשובה ביום כיפור?" });
  try {
    await ask(deps, "ומה עוד?");
    assert.equal(seen.rewrite.length, 1);
    assert.equal(seen.search[0].q, "מה אמר הרב על תשובה ביום כיפור?");
  } finally {
    stub.restore();
  }
});

test("a first question is searched as asked, and a failed rewrite falls back to it", async () => {
  const big = "א".repeat(FULL_TEXT_MAX_CHARS + 1);

  let db = flowDb({ chunks: [recording(0, big)] });
  let fake = fakeDeps({ hits: [recording(0)] });
  try {
    await ask(fake.deps, "מה זה תשובה?");
    assert.equal(fake.seen.rewrite.length, 0, "nothing to rewrite without history");
    assert.equal(fake.seen.search[0].q, "מה זה תשובה?");
  } finally {
    db.stub.restore();
  }

  db = flowDb({ chunks: [recording(0, big)], history: [{ role: "user", content: "x" }] });
  fake = fakeDeps({ hits: [recording(0)], rewritten: new Error("timeout") });
  try {
    await ask(fake.deps, "ומה עוד?");
    assert.equal(fake.seen.search[0].q, "ומה עוד?");
  } finally {
    db.stub.restore();
  }
});

test("when retrieval finds nothing, the answer says so without paying the model", async () => {
  const big = "א".repeat(FULL_TEXT_MAX_CHARS + 1);
  const { stub, stored } = flowDb({ chunks: [recording(0, big)] });
  const { deps, seen } = fakeDeps({ hits: [] });
  try {
    const result = await ask(deps);
    assert.equal(seen.answer.length, 0);
    assert.equal(result.messages[1].content, NOTHING_FOUND_ANSWER);
    assert.deepEqual(stored[1].citations, []);
  } finally {
    stub.restore();
  }
});

// ── Grounding and history ───────────────────────────────────────────────────

test("the system prompt names the lesson and forbids answering from outside it", () => {
  const prompt = systemPrompt({ title: "שיחת הכנה", creator: "הרב כהן", isBook: false });
  assert.match(prompt, /"שיחת הכנה" מאת הרב כהן/);
  assert.match(prompt, /אך ורק על סמך הקטעים/);
  assert.match(prompt, /אל תפסוק הלכה/);
  assert.match(prompt, /התמלול של השיעור/);
  assert.match(systemPrompt({ title: "t", creator: "c", isBook: true }), /הטקסט של הספר/);
});

test("history goes back to the model with its old citation numbers removed", async () => {
  const history = [{ role: "user", content: "שאלה" }, { role: "assistant", content: "תשובה [2][3]." }];
  const { stub } = flowDb({ history });
  const { deps, seen } = fakeDeps();
  try {
    await ask(deps);
    const sent = seen.answer[0];
    assert.equal(sent[0].role, "system");
    assert.deepEqual(sent[2], { role: "assistant", content: "תשובה." }, "[2] would point at today's passage 2");
    const read = stub.calls.find((c) => /FROM ai_messages/i.test(c.text));
    assert.equal(read.params[1], HISTORY_MESSAGES);
  } finally {
    stub.restore();
  }
});

// ── Citations ───────────────────────────────────────────────────────────────

test("an invented citation is removed from the text and never stored", () => {
  const { answer, cited } = validateAnswer({ answer: "כך [1] וגם כך [9][2].", citations: [2, 7, "x"] }, 3);
  assert.equal(answer, "כך [1] וגם כך [2].");
  assert.deepEqual(cited, [1, 2]);
});

// PRD ASK-3: "אין ציטוט — אין תשובה". A claim with no source is withheld.
test("an answer that cites nothing is withheld, not shown", () => {
  const result = validateAnswer({ found: true, answer: "הרב אמר שצריך לצום שלושה ימים.", citations: [] }, 3);
  assert.equal(result.answer, UNGROUNDED_ANSWER);
  assert.equal(result.grounded, false);
  assert.deepEqual(result.cited, []);
});

test("an answer whose only citations were invented is withheld too", () => {
  const result = validateAnswer({ found: true, answer: "כך נאמר [9].", citations: [9] }, 3);
  assert.equal(result.answer, UNGROUNDED_ANSWER);
});

test("a reply that does not say whether it found anything is treated as a claim", () => {
  assert.equal(validateAnswer({ answer: "כך וכך." }, 3).answer, UNGROUNDED_ANSWER);
});

// The one rightly uncited answer.
test("'not discussed here' passes without a citation", () => {
  const result = validateAnswer({ found: false, answer: "הנושא הזה לא נידון בשיעור.", citations: [] }, 3);
  assert.equal(result.answer, "הנושא הזה לא נידון בשיעור.");
  assert.equal(result.grounded, true);
});

test("the prompt asks the model to say whether it found the answer", () => {
  assert.match(systemPrompt({ title: "t", creator: "c", isBook: false }), /"found"/);
});

test("a citation only in the list still counts, if it is real", () => {
  assert.deepEqual(validateAnswer({ answer: "תשובה", citations: [3, 1, 3] }, 3).cited, [1, 3]);
});

test("a reply with no answer is a failure, not an empty message", () => {
  assert.throws(() => validateAnswer({ citations: [1] }, 3));
  assert.throws(() => validateAnswer({ answer: "   " }, 3));
});

test("a withheld answer is what gets stored, with no citations", async () => {
  const { stub, stored } = flowDb();
  const { deps } = fakeDeps({ reply: { found: true, answer: "טענה בלי מקור", citations: [] } });
  try {
    await ask(deps);
    assert.equal(stored[1].content, UNGROUNDED_ANSWER);
    assert.deepEqual(stored[1].citations, []);
  } finally {
    stub.restore();
  }
});

test("a stored citation is a snapshot of where the passage is, not a chunk id", async () => {
  const { stub, stored } = flowDb({ chunks: [recording(0), recording(1, "התשובה היא חזרה")] });
  const { deps } = fakeDeps({ reply: { answer: "חזרה [2].", citations: [2] } });
  try {
    await ask(deps);
    const [citation] = stored[1].citations;
    assert.deepEqual(
      { n: citation.n, start_time: citation.start_time, quote: citation.quote },
      { n: 2, start_time: 600, quote: "התשובה היא חזרה" }
    );
    assert.equal("id" in citation || "chunk_id" in citation, false, "re-processing replaces every chunk id");
  } finally {
    stub.restore();
  }
});

test("a passage is labelled by time, by page, or by position — whichever it has", () => {
  assert.equal(passageLabel({ start_time: 0 }), "0:00", "0 is a real start time, not a missing one");
  assert.equal(passageLabel({ start_time: 3725 }), "1:02:05");
  assert.equal(passageLabel({ start_time: null, page_number: 47 }), "עמ' 47");
  assert.equal(passageLabel({ start_time: null, page_number: null, chunk_index: 4 }), "קטע 5");
});

// ── Failure and refusal ─────────────────────────────────────────────────────

test("a failed answer is a 502 the user can act on, and stores nothing", async () => {
  const { stub, stored } = flowDb();
  const { deps } = fakeDeps({ reply: new Error("upstream 500") });
  try {
    await assert.rejects(() => ask(deps), { statusCode: 502, code: "AI_ANSWER_FAILED" });
    assert.equal(stored.length, 0, "the retry must not leave the question in the thread twice");
  } finally {
    stub.restore();
  }
});

test("a lesson with no text yet is 'not ready', and opens no conversation", async () => {
  const { stub } = flowDb({ chunks: [], conversations: [] });
  const { deps, seen } = fakeDeps();
  try {
    await assert.rejects(() => ask(deps), { statusCode: 409, code: "AI_NOT_READY" });
    assert.equal(stub.calls.some((c) => /ai_conversations/i.test(c.text)), false);
    assert.equal(seen.answer.length, 0);
  } finally {
    stub.restore();
  }
});

test("a lesson the caller may not see is refused before its text is read", async () => {
  const { stub } = flowDb({ lesson: { ...LESSON, course_id: 5 } });
  const { deps, seen } = fakeDeps();
  try {
    await assert.rejects(
      () => askInLesson({ user: { id: 7 }, mediaId: 3, question: "x", scope: { courses: [], drafts: [] }, deps }),
      { statusCode: 404 }
    );
    assert.equal(stub.calls.some((c) => /transcript_chunks/i.test(c.text)), false);
    assert.equal(seen.answer.length, 0);
  } finally {
    stub.restore();
  }
});

test("the question and the answer are stored in order, and both returned", async () => {
  const { stub, stored } = flowDb({ conversations: [] });
  const { deps } = fakeDeps();
  try {
    const result = await ask(deps, "מה העיקר?");
    assert.deepEqual(stored.map((m) => m.role), ["user", "assistant"]);
    assert.equal(stored[0].content, "מה העיקר?");
    assert.equal(result.conversation.id, 17, "a first question opens the conversation");
    assert.deepEqual(result.messages.map((m) => m.role), ["user", "assistant"]);
  } finally {
    stub.restore();
  }
});

// ── Over HTTP ───────────────────────────────────────────────────────────────
// Only what stops before OpenAI: the controller's own validation.

const app = createApp();
const ADMIN_ROW = { id: 1, email: "a@example.com", role: "admin" };
const token = jwt.sign({ id: 1, email: "a@example.com", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

test("a missing, blank, non-string or oversized question is refused before any work", async (t) => {
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM users/i.test(text)) return { rows: [ADMIN_ROW] };
    if (/media_items|transcript_chunks|ai_/i.test(text)) throw new Error("reached the chat with a bad question");
    return { rows: [] };
  });
  try {
    for (const [name, body] of [
      ["missing", {}],
      ["blank", { question: "   " }],
      ["not a string", { question: ["a"] }],
      ["oversized", { question: "א".repeat(1001) }],
    ]) {
      const res = await request(app).post("/api/discussion/42/messages").set("Cookie", `token=${token}`).send(body);
      await t.test(name, () => assert.equal(res.status, 400));
    }
  } finally {
    stub.restore();
  }
});
