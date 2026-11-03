import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { openai } from "../services/transcripts/gpt.js";
import {
  buildQuestionsPrompt,
  parseQuestions,
  generateSuggestedQuestions,
  QUESTION_COUNT,
  MAX_QUESTION_LENGTH,
} from "../services/transcripts/questions.js";

// Three questions to start the chat with, about this lesson (PRD ASK-7,
// migration 045).

test("the prompt asks for questions about this lesson, from its summary", () => {
  const [system, user] = buildQuestionsPrompt({ title: "פרשת כי תבא", summary: "על הבאת ביכורים", keyPoints: ["שמחה"] });
  assert.match(system.content, /THIS lesson/);
  assert.match(system.content, new RegExp(`${QUESTION_COUNT} short questions`));
  assert.match(user.content, /Summary: על הבאת ביכורים/);
  assert.match(user.content, /- שמחה/);
});

test("the answer keeps short, distinct strings — three at most — and nothing for a bad answer", () => {
  const long = "א".repeat(MAX_QUESTION_LENGTH + 1);
  const raw = JSON.stringify({ questions: ["  מה הקשר בין ביכורים לשמחה?  ", 7, "מה הקשר בין ביכורים לשמחה?", long, "", "למה דווקא בארץ?", "מי מביא?", "עוד אחת?"] });
  assert.deepEqual(parseQuestions(raw), ["מה הקשר בין ביכורים לשמחה?", "למה דווקא בארץ?", "מי מביא?"]);
  assert.deepEqual(parseQuestions("not json"), []);
  assert.deepEqual(parseQuestions('{"questions":"x"}'), []);
});

const withModel = async (content, fn) => {
  const original = openai.chat.completions.create;
  const calls = [];
  openai.chat.completions.create = async (params) => {
    calls.push(params);
    return { model: "gpt-4o", usage: { prompt_tokens: 500, completion_tokens: 60 }, choices: [{ message: { content } }] };
  };
  try {
    return await fn(calls);
  } finally {
    openai.chat.completions.create = original;
  }
};

test("writes the lesson's questions from its summary, and the call is metered", async () => {
  const db = stubPoolQuery(pool, (text) =>
    /FROM media_items m JOIN transcripts/.test(text) ? { rows: [{ title: "ש", ai_summary: "סיכום", ai_key_points: [] }] } : { rows: [] }
  );
  try {
    await withModel(JSON.stringify({ questions: ["א?", "מה נאמר על ביכורים?", "למה בשמחה?"] }), async (calls) => {
      const questions = await generateSuggestedQuestions(9);
      // "א?" is too short to be a question worth a chip.
      assert.deepEqual(questions, ["מה נאמר על ביכורים?", "למה בשמחה?"]);
      assert.deepEqual(calls[0].response_format, { type: "json_object" });
    });
    const update = db.calls.find((c) => /UPDATE transcripts SET suggested_questions/.test(c.text));
    assert.deepEqual(JSON.parse(update.params[1]), ["מה נאמר על ביכורים?", "למה בשמחה?"]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(db.calls.some((c) => /INSERT INTO ai_usage/.test(c.text) && c.params.includes("suggested_questions")));
  } finally {
    db.restore();
  }
});

test("a lesson with no summary is left alone, and the model is not asked", async () => {
  const db = stubPoolQuery(pool, (text) =>
    /FROM media_items m JOIN transcripts/.test(text) ? { rows: [{ title: "ש", ai_summary: null }] } : { rows: [] }
  );
  try {
    await withModel("{}", async (calls) => {
      assert.equal(await generateSuggestedQuestions(9), null);
      assert.equal(calls.length, 0);
    });
    assert.equal(db.calls.some((c) => /UPDATE transcripts/.test(c.text)), false);
  } finally {
    db.restore();
  }
});

// A regenerated summary must not sit beside questions about the previous one.
test("an answer with no usable question clears the old ones", async () => {
  const db = stubPoolQuery(pool, (text) =>
    /FROM media_items m JOIN transcripts/.test(text) ? { rows: [{ title: "ש", ai_summary: "סיכום" }] } : { rows: [] }
  );
  try {
    await withModel("not json", () => generateSuggestedQuestions(9));
    const update = db.calls.find((c) => /UPDATE transcripts SET suggested_questions/.test(c.text));
    assert.equal(update.params[1], null);
  } finally {
    db.restore();
  }
});
