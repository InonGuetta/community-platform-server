// @ts-check
// Three questions to ask about this lesson (PRD ASK-7, migration 045).
//
// The chat offers them when a conversation is empty, so the first question
// costs no thought — and is about this lesson, not "what is the main point?"
// on every lesson alike. Drawn from the summary and key points, the same input
// the tag proposals read: a few hundred words that already say what the
// lesson is about.
//
// They are offered as chips — part of the interface, not of the lesson — so
// they are written in every interface language (migration 053), in one call:
// the same three questions in Hebrew, Yiddish, English, French and Spanish,
// stored as {"he": [...], "en": [...], …}. The reader sees their own language;
// a language the model left out falls back, on the client, to the fixed
// questions in that language.
//
// gpt-4o, under a cent a lesson; metered as "suggested_questions" (PRD ADM-1).
// Never fatal to processing: a lesson with no questions shows the fixed ones.
import { pool } from "../../db/pool.js";
import { meterOpenAI } from "../../lib/openaiClient.js";
import { logger } from "../../lib/logger.js";
import { LANGUAGE_CODES } from "../../lib/languages.js";
import { openai as baseOpenai, GPT_MODEL } from "./gpt.js";

export const QUESTION_COUNT = 3;
// A chip on a phone: a short line, not a paragraph. Room for French and
// Spanish, which run longer than the Hebrew they say.
export const MAX_QUESTION_LENGTH = 120;

// What each code is called in the prompt.
const LANGUAGE_NAMES = { he: "Hebrew", yi: "Yiddish (YIVO spelling)", en: "English", fr: "French", es: "Spanish" };

const client = meterOpenAI(baseOpenai, "suggested_questions");

export const buildQuestionsPrompt = ({ title, summary, keyPoints = [] }) => [
  {
    role: "system",
    content:
      "You help learners start a conversation about a Torah lesson. " +
      `Write ${QUESTION_COUNT} short questions that a learner might ask about THIS lesson — ` +
      "specific to its content, each answerable from what the lesson itself says, different from one another, " +
      `at most ${MAX_QUESTION_LENGTH} characters each, phrased as the learner would ask them. ` +
      `Give the same ${QUESTION_COUNT} questions in each of these languages: ` +
      LANGUAGE_CODES.map((code) => `${code} = ${LANGUAGE_NAMES[code]}`).join(", ") +
      ". Keep names of people, books and places as they are usually written in each language. " +
      'Reply with JSON only: {"questions":{' +
      LANGUAGE_CODES.map((code) => `"${code}":["...","...","..."]`).join(",") +
      "}}",
  },
  {
    role: "user",
    content: [
      `Lesson title: ${title || ""}`,
      `Summary: ${summary || ""}`,
      ...(keyPoints.length ? ["Key points:", ...keyPoints.map((k) => `- ${typeof k === "string" ? k : k?.text ?? ""}`)] : []),
    ].join("\n"),
  },
];

/**
 * One language's list, checked: strings only, trimmed, not empty, not too
 * long, each once, at most QUESTION_COUNT.
 * @param {unknown} list
 */
const cleanList = (list) => {
  const seen = new Set();
  const out = [];
  for (const q of Array.isArray(list) ? list : []) {
    if (typeof q !== "string") continue;
    const text = q.trim().replace(/\s+/g, " ");
    if (text.length < 4 || text.length > MAX_QUESTION_LENGTH || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= QUESTION_COUNT) break;
  }
  return out;
};

/**
 * The model's answer, checked language by language: an object holding only
 * the interface languages that came back with at least one usable question —
 * and an empty object for an answer that is not the JSON asked for.
 * @param {string} raw
 * @returns {Record<string, string[]>}
 */
export const parseQuestions = (raw) => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const byLanguage = parsed?.questions && typeof parsed.questions === "object" && !Array.isArray(parsed.questions)
    ? parsed.questions
    : {};
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const code of LANGUAGE_CODES) {
    const list = cleanList(byLanguage[code]);
    if (list.length) out[code] = list;
  }
  return out;
};

/**
 * Writes the lesson's suggested questions from its summary, in every interface
 * language. Returns them ({ he: [...], … }), or null when there is no summary
 * to draw from (nothing is written then).
 * A run that yields none clears any old ones, so a regenerated summary never
 * sits beside questions about the previous one.
 */
export const generateSuggestedQuestions = async (mediaId) => {
  const { rows: [lesson] } = await pool.query(
    `SELECT m.title, t.ai_summary, t.ai_key_points
       FROM media_items m JOIN transcripts t ON t.media_id = m.id
      WHERE m.id = $1`,
    [mediaId]
  );
  if (!lesson?.ai_summary) return null;

  const completion = await client.chat.completions.create({
    model: GPT_MODEL,
    temperature: 0.4,
    // Five languages of three short questions each.
    max_tokens: 1200,
    response_format: { type: "json_object" },
    messages: buildQuestionsPrompt({
      title: lesson.title,
      summary: lesson.ai_summary,
      keyPoints: Array.isArray(lesson.ai_key_points) ? lesson.ai_key_points : [],
    }),
  });
  const questions = parseQuestions(completion.choices?.[0]?.message?.content ?? "");
  await pool.query(
    "UPDATE transcripts SET suggested_questions = $2::jsonb WHERE media_id = $1",
    [mediaId, Object.keys(questions).length ? JSON.stringify(questions) : null]
  );
  logger.debug(`[questions] mediaId=${mediaId} wrote questions in: ${Object.keys(questions).join(", ") || "(none)"}`);
  return questions;
};
