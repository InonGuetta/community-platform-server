// @ts-check
// ── What the model is shown ──────────────────────────────────────────────────
//
// The chat answers from a lesson's own text and nothing else. This module
// decides WHICH of that text a question is sent with, and how it is labelled
// so the answer can cite it.
//
// Two strategies, chosen by size, not by media type:
//
//   full  — a lesson short enough to fit is sent WHOLE. A 20-minute shiur is
//           ~3,000 words; retrieval over it can only lose things (an answer
//           that spans minute 2 and minute 17, a "what was the main point"),
//           and gains nothing a model reading all of it would miss.
//
//   rag   — a long lesson, and almost every book, is too large to send. The
//           question is first made standalone (a follow-up like "ומה הוא אמר
//           על זה?" means nothing to a search on its own), then the lesson's
//           own retrieval (./retrieval.js — keyword + exact vector + rerank)
//           picks the passages.
//
// Either way the passages go to the model numbered [1]..[n] in the ORDER THEY
// APPEAR in the lesson, each labelled with where it is — a time in a recording,
// a page in a book — and that number is what the answer cites.
import { pool } from "../../db/pool.js";

// Roughly 20–25k tokens of Hebrew. Above this a whole lesson stops being cheap
// to send with every question, and a long book would not fit at all.
export const FULL_TEXT_MAX_CHARS = 50_000;

// How much of a passage a citation keeps as its quote — enough to recognise the
// passage in a tooltip, not a second copy of the transcript in every message.
const QUOTE_CHARS = 160;

// Every chunk of the lesson, in reading order. The embedding is not selected.
export const lessonChunks = async (mediaId) => {
  const { rows } = await pool.query(
    `SELECT id, chunk_index, start_time, end_time, page_number, char_start, content
     FROM transcript_chunks
     WHERE media_id = $1
     ORDER BY chunk_index`,
    [mediaId]
  );
  return rows;
};

// "12:34", or "1:02:05" past the hour.
const clock = (seconds) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

// Where a passage is, in the unit people use for it. A recording has a time and
// no page; a PDF has a page and no time; a .txt or .docx has neither, and is
// cited by its position. Checked as `!= null` because 0 is a real start time.
export const passageLabel = (chunk) => {
  if (chunk.start_time != null) return clock(chunk.start_time);
  if (chunk.page_number != null) return `עמ' ${chunk.page_number}`;
  return `קטע ${Number(chunk.chunk_index) + 1}`;
};

// The numbered block the model reads.
export const formatPassages = (passages) =>
  passages.map((p, i) => `[${i + 1}] (${passageLabel(p)})\n${p.content}`).join("\n\n");

// What a citation stores (migration 032): the facts about the ORIGINAL that a
// re-run of the pipeline never moves, copied — never a chunk id.
export const citationSnapshot = (passage, n) => ({
  n,
  chunk_index: passage.chunk_index,
  start_time: passage.start_time ?? null,
  end_time: passage.end_time ?? null,
  page_number: passage.page_number ?? null,
  char_start: passage.char_start ?? null,
  quote: String(passage.content ?? "").slice(0, QUOTE_CHARS),
});

/**
 * Choose the passages a question is answered from.
 * @param {object} args
 * @param {number|string} args.mediaId
 * @param {string} args.question
 * @param {Array<{ role: string, content: string }>} args.history  oldest first
 * @param {any[]} args.chunks  the lesson's chunks, from lessonChunks
 * @param {{ courses: number[]|null, drafts: number[]|null }} args.scope
 * @param {{
 *   rewrite: (history: any[], question: string) => Promise<string>,
 *   search: (mediaId: any, q: string, scope: any) => Promise<any[]>,
 * }} args.deps
 * @returns {Promise<{ mode: "full"|"rag", passages: any[] }>}
 */
export const buildContext = async ({ mediaId, question, history, chunks, scope, deps }) => {
  const totalChars = chunks.reduce((sum, c) => sum + String(c.content ?? "").length, 0);
  if (totalChars <= FULL_TEXT_MAX_CHARS) return { mode: "full", passages: chunks };

  // Only a follow-up needs rewriting, and the rewrite is best-effort: a failed
  // call searches with the question as asked, which is worse only for
  // follow-ups and never wrong.
  let searchFor = question;
  if (history.length > 0) {
    try {
      searchFor = (await deps.rewrite(history, question)) || question;
    } catch {
      searchFor = question;
    }
  }

  const hits = await deps.search(mediaId, searchFor, scope);
  // Reading order, not relevance order: the model follows an argument better
  // when its passages arrive in the order the lecturer made it.
  const passages = [...hits].sort((a, b) => a.chunk_index - b.chunk_index);
  return { mode: "rag", passages };
};
