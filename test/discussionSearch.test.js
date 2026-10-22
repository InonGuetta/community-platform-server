import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { searchWithinMedia, substringPatterns, substringHeadline, RESULT_LIMIT } from "../services/discussion/retrieval.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// The smart search on the "דיון עם AI" tab: search inside ONE lesson.
//
// The property everything here protects is isolation. A lesson's "RAG" is its
// own rows of transcript_chunks and nothing else, so a statement that reads
// chunks without `media_id = $1` would answer a question about one shiur from
// another — with real, plausible text, and no error anywhere.
//
// OpenAI is never called: the embedding and the rerank are injected, so the
// real SQL builder and the real fallbacks run against a stubbed pool.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const ADMIN_SCOPE = { courses: null, drafts: null };
const STUDENT_SCOPE = { courses: [], drafts: [] };

const VISIBLE_LESSON = { is_published: true, course_id: null, uploader_id: 9 };

const chunk = (id, extra = {}) => ({
  id, chunk_index: id, start_time: id * 60, end_time: id * 60 + 60,
  page_number: null, char_start: null, char_end: null,
  content: `קטע ${id}`, headline: `קטע ${id}`, similarity: 0.5, ...extra,
});

const fakeEmbed = async () => Array(1536).fill(0.01);
const passThroughRerank = async (_q, rows, limit) => rows.slice(0, limit);

// Answers the visibility lookup with `lesson`, and every chunk query with `rows`.
const lessonDb = (lesson, rows = []) =>
  stubPoolQuery(pool, (text) => {
    if (/FROM media_items/i.test(text)) return { rows: lesson ? [lesson] : [] };
    if (/transcript_chunks/i.test(text)) return { rows };
    return { rows: [] };
  });

const chunkQueries = (stub) => stub.calls.filter((c) => /transcript_chunks/i.test(c.text));

test("every statement that reads chunks is confined to the lesson", async () => {
  const stub = lessonDb(VISIBLE_LESSON, [chunk(1)]);
  try {
    await searchWithinMedia(42, "תשובה", ADMIN_SCOPE, { embed: fakeEmbed, rerank: passThroughRerank });
    const reads = chunkQueries(stub);
    assert.ok(reads.length > 0, "the search should have read chunks at all");
    for (const call of reads) {
      assert.match(call.text, /WHERE media_id = \$1/, "the lesson's chunks must be selected by media_id");
      assert.match(call.text, /c\.media_id = \$1/, "and the final join must not reach outside it");
      assert.equal(call.params[0], 42);
    }
  } finally {
    stub.restore();
  }
});

test("the vector half ranks the lesson's own rows, never the archive-wide index", async () => {
  // MATERIALIZED is what makes this true: ORDER BY over a materialized CTE
  // cannot use the HNSW index, whose ~40-row walk over the whole archive would
  // leave one lesson with almost nothing after filtering.
  const stub = lessonDb(VISIBLE_LESSON, [chunk(1)]);
  try {
    await searchWithinMedia(42, "תשובה", ADMIN_SCOPE, { embed: fakeEmbed, rerank: passThroughRerank });
    const [call] = chunkQueries(stub);
    assert.match(call.text, /lesson AS MATERIALIZED/);
    assert.match(call.text, /vec AS \([\s\S]*FROM lesson/, "the vector ranking must read the materialized lesson");
    assert.match(call.params[2], /^\[0\.01,/, "the query embedding travels as the third parameter");
  } finally {
    stub.restore();
  }
});

test("a lesson the caller may not see is refused before any chunk is read", async () => {
  let embedded = false;
  const stub = lessonDb({ is_published: true, course_id: 5, uploader_id: 9 }, [chunk(1)]);
  try {
    await assert.rejects(
      () => searchWithinMedia(3, "x", STUDENT_SCOPE, {
        embed: async () => { embedded = true; return [0]; },
        rerank: passThroughRerank,
      }),
      { statusCode: 404, code: "MEDIA_NOT_FOUND" }
    );
    assert.equal(chunkQueries(stub).length, 0, "a refused request must not read the text it was refused");
    assert.equal(embedded, false, "nor pay OpenAI to embed the question");
  } finally {
    stub.restore();
  }
});

test("a lesson that does not exist is a 404, not an empty list", async () => {
  const stub = lessonDb(null);
  try {
    await assert.rejects(
      () => searchWithinMedia(999, "x", ADMIN_SCOPE, { embed: fakeEmbed, rerank: passThroughRerank }),
      { statusCode: 404 }
    );
  } finally {
    stub.restore();
  }
});

test("when the question cannot be embedded, keyword search still answers", async () => {
  let reranked = false;
  const stub = lessonDb(VISIBLE_LESSON, [chunk(1), chunk(2)]);
  try {
    const rows = await searchWithinMedia(42, "תשובה", ADMIN_SCOPE, {
      embed: async () => { throw new Error("OpenAI unavailable"); },
      rerank: async (_q, r) => { reranked = true; return r; },
    });
    assert.equal(rows.length, 2);
    const [call] = chunkQueries(stub);
    assert.doesNotMatch(call.text, /<=>/, "no vector operator without a vector");
    assert.equal(call.params.length, 3, "media, query text, substring patterns — and no vector");
    assert.deepEqual(call.params[2], ["%תשובה%"]);
    assert.equal(reranked, false, "OpenAI is down; a rerank would only wait out a second failure");
  } finally {
    stub.restore();
  }
});

test("a failed rerank keeps the fused order instead of failing the search", async () => {
  const stub = lessonDb(VISIBLE_LESSON, [chunk(1), chunk(2), chunk(3)]);
  try {
    const rows = await searchWithinMedia(42, "תשובה", ADMIN_SCOPE, {
      embed: fakeEmbed,
      rerank: async () => { throw new Error("bad JSON"); },
    });
    assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
  } finally {
    stub.restore();
  }
});

test("results are capped, and the rerank is asked for exactly that many", async () => {
  let askedFor;
  const many = Array.from({ length: 15 }, (_, i) => chunk(i + 1));
  const stub = lessonDb(VISIBLE_LESSON, many);
  try {
    const rows = await searchWithinMedia(42, "תשובה", ADMIN_SCOPE, {
      embed: fakeEmbed,
      rerank: async (_q, r, limit) => { askedFor = limit; return r.slice(0, limit); },
    });
    assert.equal(askedFor, RESULT_LIMIT);
    assert.equal(rows.length, RESULT_LIMIT);
  } finally {
    stub.restore();
  }
});

test("a book's hit carries its page, so the client can open it there", async () => {
  const stub = lessonDb(VISIBLE_LESSON, [chunk(1, { start_time: null, end_time: null, page_number: 47, char_start: 1200 })]);
  try {
    const [hit] = await searchWithinMedia(42, "תשובה", ADMIN_SCOPE, { embed: fakeEmbed, rerank: passThroughRerank });
    assert.equal(hit.page_number, 47);
    assert.equal(hit.start_time, null);
    assert.match(chunkQueries(stub)[0].text, /c\.page_number/, "the page must be selected, not left to chance");
  } finally {
    stub.restore();
  }
});

// ── Hebrew words inside Hebrew words ────────────────────────────────────────
// Found in the browser: a lesson that says "שאמריקאים" and "אמריקאית" came
// back empty for "אמריקאים", because full-text search matches whole words and
// Hebrew glues its prefixes on. Without OpenAI the keyword half is ALL there
// is, and it was missing every form of the word.

test("the keyword half also matches a word inside a word", async () => {
  const stub = lessonDb(VISIBLE_LESSON, [chunk(1)]);
  try {
    await searchWithinMedia(42, "אמריקאים", ADMIN_SCOPE, { embed: fakeEmbed, rerank: passThroughRerank });
    const [call] = chunkQueries(stub);
    assert.match(call.text, /content ILIKE ANY\(\$4::text\[\]\)/);
    assert.deepEqual(call.params[3], ["%אמריקאים%"]);
  } finally {
    stub.restore();
  }
});

test("a typed prefix is also tried without it", () => {
  assert.deepEqual(substringPatterns("התשובה"), ["%התשובה%", "%תשובה%"]);
  assert.deepEqual(substringPatterns("ותפילה"), ["%ותפילה%", "%תפילה%"]);
  // Too short to strip: "בית" without its first letter is not a word.
  assert.deepEqual(substringPatterns("בית"), ["%בית%"]);
});

test("short words, which are in every chunk, are not patterns", () => {
  assert.deepEqual(substringPatterns("מה נאמר על זה"), ["%נאמר%"]);
});

test("nothing typed can widen a pattern: %, _ and backslash never reach it", () => {
  for (const pattern of substringPatterns("50% a_b c\\d %%% ___")) {
    assert.doesNotMatch(pattern.slice(1, -1), /[%_\\]/, pattern);
  }
});

test("the quote marks of an abbreviation stay, so רמב\"ם still matches itself", () => {
  assert.deepEqual(substringPatterns('הרמב"ם?'), ['%הרמב"ם%', '%רמב"ם%']);
  assert.deepEqual(substringPatterns("\"תשובה\""), ["%תשובה%"], "quotes around a word are not part of it");
});

// ── Over HTTP ───────────────────────────────────────────────────────────────
// Only the paths that stop before OpenAI: the controller's own validation.

const app = createApp();
const ADMIN_ROW = { id: 1, email: "a@example.com", role: "admin" };
const token = jwt.sign({ id: 1, email: "a@example.com", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

test("the search refuses a missing, blank or oversized query before any work", async (t) => {
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM users/i.test(text)) return { rows: [ADMIN_ROW] };
    if (/transcript_chunks|FROM media_items/i.test(text)) throw new Error("reached the search with a bad query");
    return { rows: [] };
  });
  try {
    for (const [name, qs] of [
      ["missing", ""],
      ["blank", "?q=%20%20"],
      ["repeated", "?q=a&q=b"],
      ["oversized", `?q=${"א".repeat(301)}`],
    ]) {
      const res = await request(app).get(`/api/discussion/3/search${qs}`).set("Cookie", `token=${token}`);
      await t.test(name, () => assert.equal(res.status, 400));
    }
  } finally {
    stub.restore();
  }
});

test("a non-numeric lesson id is a 400, not a database error", async () => {
  const stub = stubPoolQuery(pool, (text) => (/FROM users/i.test(text) ? { rows: [ADMIN_ROW] } : { rows: [] }));
  try {
    const res = await request(app).get("/api/discussion/abc/search?q=x").set("Cookie", `token=${token}`);
    assert.equal(res.status, 400);
  } finally {
    stub.restore();
  }
});

// ── Marking what a substring hit matched ────────────────────────────────────
// ts_headline marks only full-text matches. A chunk found by a word inside a
// word came back with its first line and nothing marked.

test("a substring hit gets a snippet around its match, marked", () => {
  const content = `${"פתיחה ".repeat(40)}ואמרו שאמריקאים רבים הגיעו לשם ${"סיום ".repeat(40)}`;
  const headline = substringHeadline(content, substringPatterns("אמריקאים"));
  assert.match(headline, /ש<b>אמריקאים<\/b> רבים/);
  assert.ok(headline.length < content.length, "a window, not the whole chunk");
  assert.doesNotMatch(headline, /^\S*פתיחה פתיחה פתיחה פתיחה פתיחה פתיחה פתיחה פתיחה פתיחה פתיחה פתיחה פתיחה פתיחה פתיחה פתיחה פתיחה/);
});

test("the longer form is marked whole, not its shorter part", () => {
  const headline = substringHeadline("והתשובה היא חזרה", substringPatterns("התשובה"));
  assert.equal(headline, "ו<b>התשובה</b> היא חזרה");
});

test("no match leaves the row's own snippet", () => {
  assert.equal(substringHeadline("טקסט אחר", substringPatterns("אמריקאים")), null);
});

test("a full-text snippet is kept, and an unmarked one is replaced", async () => {
  const stub = lessonDb(VISIBLE_LESSON, [
    chunk(1, { headline: "כבר <b>מסומן</b>" }),
    chunk(2, { headline: "שורה ראשונה", content: "שורה ראשונה ואחריה שאמריקאים" }),
  ]);
  try {
    const rows = await searchWithinMedia(42, "אמריקאים", ADMIN_SCOPE, { embed: fakeEmbed, rerank: passThroughRerank });
    assert.equal(rows[0].headline, "כבר <b>מסומן</b>");
    assert.match(rows[1].headline, /ש<b>אמריקאים<\/b>/);
  } finally {
    stub.restore();
  }
});
