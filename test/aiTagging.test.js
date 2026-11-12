import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery, stubPoolConnect } from "./setup.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";
import { interactiveOpenai } from "../services/transcripts/gpt.js";
import {
  tagPaths,
  candidateTags,
  parseTagChoices,
  buildTaggingPrompt,
  TAGGING_MODEL,
  MAX_SUGGESTIONS,
} from "../services/transcripts/tagging.js";

// Tags the LLM proposes for a lesson (PRD ARCH-4, migration 044): chosen only
// from the tree, never applied without a person, and only by whoever may tag
// the lesson.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();
const OWNER = { id: 10, email: "o@example.com", role: "lecturer", is_active: true };
const OTHER = { id: 11, email: "x@example.com", role: "lecturer", is_active: true };
const cookieFor = (u) => `token=${jwt.sign({ id: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;

const TREE = [
  { id: 1, name: "תנ\"ך", parent_id: null },
  { id: 2, name: "שמות", parent_id: 1 },
  { id: 3, name: "שמות", parent_id: 2 },
  { id: 4, name: "מוסר", parent_id: null },
];

test("each tag is shown as its path, so two of one name are two lines", () => {
  assert.deepEqual(tagPaths(TREE), [
    { id: 1, path: "תנ\"ך" },
    { id: 2, path: "תנ\"ך > שמות" },
    { id: 3, path: "תנ\"ך > שמות > שמות" },
    { id: 4, path: "מוסר" },
  ]);
});

// Measured on a real lesson tagged "כי תבא": the first answer offered "דברים",
// its book — a tag that adds nothing the existing one does not already reach.
test("a tag above one already on the lesson, or above another choice, is dropped", () => {
  const raw = JSON.stringify({ tags: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] });
  // Tagged 3 (שמות > שמות): 2 and 1 are above it.
  assert.deepEqual(parseTagChoices(raw, [1, 2, 3, 4], [3], TREE).map((c) => c.id), [4]);
  // Nothing tagged: 3 is chosen, so 2 and 1 above it go.
  assert.deepEqual(parseTagChoices(raw, [1, 2, 3, 4], [], TREE).map((c) => c.id), [3, 4]);
});

test("a top-level category with tags under it is not offered; one with none is", () => {
  const ids = candidateTags([...TREE, { id: 5, name: "שונות", parent_id: null }]).map((t) => t.id);
  assert.deepEqual(ids, [2, 3, 4, 5]);
});

test("the prompt carries the tree and what the lesson is about", () => {
  const [system, user] = buildTaggingPrompt({ title: "שיעור", summary: "על יציאת מצרים", keyPoints: ["נקודה"] }, tagPaths(TREE));
  assert.match(system.content, /only ids from the list/);
  assert.match(system.content, /never pad the list/);
  assert.match(system.content, /never both a tag and one of its ancestors/);
  assert.match(user.content, /3: תנ"ך > שמות > שמות/);
  assert.match(user.content, /Summary: על יציאת מצרים/);
  assert.match(user.content, /- נקודה/);
});

test("the answer keeps only real, new, distinct tags, and no more than five", () => {
  const raw = JSON.stringify({
    tags: [
      { id: 3, reason: "  על פרשת שמות  " },
      { id: 99, reason: "לא קיים" },
      { id: 4, reason: "כבר מתויג" },
      { id: 3, reason: "כפול" },
      { id: 2 },
    ],
  });
  assert.deepEqual(parseTagChoices(raw, [1, 2, 3, 4], [4]), [
    { id: 3, reason: "על פרשת שמות" },
    { id: 2, reason: null },
  ]);
  const many = JSON.stringify({ tags: [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id })) });
  assert.equal(parseTagChoices(many, [1, 2, 3, 4, 5, 6, 7]).length, MAX_SUGGESTIONS);
  assert.deepEqual(parseTagChoices("not json", [1]), []);
  assert.deepEqual(parseTagChoices("{\"tags\":\"x\"}", [1]), []);
});

// ── Through the routes ──────────────────────────────────────────────────────

const ITEM = { id: 7, title: "שיעור", uploader_id: OWNER.id, is_published: true, course_id: null, media_type: "audio" };

const db = (caller, { summary = "על יציאת מצרים", open = [] } = {}) =>
  stubPoolQuery(pool, (text) => {
    if (/FROM media_items m LEFT JOIN transcripts/.test(text)) return { rows: [{ title: "שיעור", ai_summary: summary, ai_key_points: [] }] };
    if (/WITH RECURSIVE chain/.test(text)) return { rows: open };
    if (/WITH RECURSIVE descendants/.test(text)) return { rows: TREE };
    if (/SELECT tag_id FROM media_tags/.test(text)) return { rows: [{ tag_id: 4 }] };
    if (/WHERE m\.id=\$1/.test(text)) return { rows: [ITEM] };
    if (/FROM users/.test(text)) return { rows: [caller] };
    return { rows: [] };
  });

test("asking proposes from the summary with the small model, and stores only what is valid", async () => {
  const query = db(OWNER);
  const tx = stubPoolConnect(pool, () => ({ rows: [] }));
  const original = interactiveOpenai.chat.completions.create;
  let sent;
  interactiveOpenai.chat.completions.create = async (params) => {
    sent = params;
    return { model: TAGGING_MODEL, usage: { prompt_tokens: 3000, completion_tokens: 60 },
      choices: [{ message: { content: JSON.stringify({ tags: [{ id: 3, reason: "פרשת שמות" }, { id: 4, reason: "כבר יש" }, { id: 50 }] }) } }] };
  };
  try {
    const res = await request(app).post("/api/media/7/ai-tag-suggestions").set("Cookie", cookieFor(OWNER));
    assert.equal(res.status, 200);
    assert.equal(sent.model, TAGGING_MODEL);
    assert.deepEqual(sent.response_format, { type: "json_object" });
    const insert = tx.calls.find((c) => /INSERT INTO media_ai_tag_suggestions/.test(c.text));
    assert.equal(Number(insert.params[0]), 7);
    assert.deepEqual(insert.params.slice(1), [[3], ["פרשת שמות"]]);
    // Replaced, not added to: the old proposals go in the same transaction.
    assert.ok(tx.calls.findIndex((c) => /DELETE FROM media_ai_tag_suggestions/.test(c.text)) < tx.calls.indexOf(insert));
    // Counted in the cost meter as its own purpose.
    await new Promise((resolve) => setImmediate(resolve));
    const metered = query.calls.find((c) => /INSERT INTO ai_usage/.test(c.text));
    assert.ok(metered && metered.params.includes("tagging"), "the call was not metered as tagging");
  } finally {
    interactiveOpenai.chat.completions.create = original;
    tx.restore();
    query.restore();
  }
});

test("a lesson with no summary yet is told so, and nothing is asked of the model", async () => {
  const query = db(OWNER, { summary: null });
  const original = interactiveOpenai.chat.completions.create;
  let asked = false;
  interactiveOpenai.chat.completions.create = async () => { asked = true; return {}; };
  try {
    const res = await request(app).post("/api/media/7/ai-tag-suggestions").set("Cookie", cookieFor(OWNER));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "NO_TRANSCRIPT_CONTENT");
    assert.equal(asked, false);
  } finally {
    interactiveOpenai.chat.completions.create = original;
    query.restore();
  }
});

test("only whoever may tag the lesson sees, asks for, approves or dismisses its proposals", async () => {
  const query = db(OTHER);
  try {
    for (const [method, path] of [
      ["get", "/api/media/7/ai-tag-suggestions"],
      ["post", "/api/media/7/ai-tag-suggestions"],
      ["post", "/api/media/7/ai-tag-suggestions/approve"],
      ["delete", "/api/media/7/ai-tag-suggestions"],
    ]) {
      const res = await request(app)[method](path).set("Cookie", cookieFor(OTHER)).send({ tagIds: [3] });
      assert.equal(res.status, 403, `${method} ${path}`);
    }
  } finally {
    query.restore();
  }
});

test("approving adds to the lesson's tags and closes the proposal; a tag not proposed is refused", async () => {
  const open = [{ id: 3, name: "שמות", reason: "x", path: "תנ\"ך > שמות > שמות" }];
  const query = db(OWNER, { open });
  const tx = stubPoolConnect(pool, () => ({ rows: [] }));
  try {
    const refused = await request(app).post("/api/media/7/ai-tag-suggestions/approve").set("Cookie", cookieFor(OWNER)).send({ tagIds: [2] });
    assert.equal(refused.status, 400);
    assert.equal(tx.calls.some((c) => /INSERT INTO media_tags/.test(c.text)), false);

    const res = await request(app).post("/api/media/7/ai-tag-suggestions/approve").set("Cookie", cookieFor(OWNER)).send({ tagIds: [3] });
    assert.equal(res.status, 200);
    const tagged = tx.calls.find((c) => /INSERT INTO media_tags/.test(c.text));
    // The tag it already had (4) is kept beside the new one.
    assert.deepEqual(tagged.params.slice(1).map(Number).sort(), [3, 4]);
    const closed = query.calls.find((c) => /DELETE FROM media_ai_tag_suggestions/.test(c.text));
    assert.deepEqual(closed.params[1], [3]);
  } finally {
    tx.restore();
    query.restore();
  }
});

test("dismissing closes one, or all of them", async () => {
  const query = db(OWNER);
  try {
    await request(app).delete("/api/media/7/ai-tag-suggestions?tagId=3").set("Cookie", cookieFor(OWNER));
    await request(app).delete("/api/media/7/ai-tag-suggestions").set("Cookie", cookieFor(OWNER));
    const deletes = query.calls.filter((c) => /DELETE FROM media_ai_tag_suggestions/.test(c.text));
    assert.deepEqual(deletes.map((c) => c.params[1]), [[3], null]);
  } finally {
    query.restore();
  }
});
