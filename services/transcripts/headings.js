// @ts-check
// "Subheadings by key points": take the key points already produced by the LLM
// worker and place each one on the transcript timeline. We give GPT the key
// points plus a trimmed, time-stamped view of the chunks (first words of each
// are enough to locate the topic) and ask which start_time each point belongs
// to. Output is a clickable heading list, ordered by time.
//
// The one module here that depends on another: it re-runs analysis.js when the
// stored key points are missing or too few for the transcript's length.
import { pool } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { withExclusive } from "../../lib/inFlight.js";
import { completionJson } from "../../lib/openaiClient.js";
import { notFound, badRequest, ERROR_CODES } from "../../lib/AppError.js";
import { analyzeTranscript, keyPointRange } from "./analysis.js";
import { openai, GPT_MODEL } from "./gpt.js";

const HEADINGS_PROMPT = `אתה מקבל (1) רשימת "נקודות מפתח" של שיעור בעברית, ו-(2) קטעי התמלול עם חותמת הזמן (start_time בשניות) של כל קטע.
לכל נקודת מפתח, מצא את חותמת הזמן (start_time) של הקטע שבו הנושא הזה מתחיל להידון.
החזר JSON תקין בלבד במבנה: { "headings": [{ "title": "נקודת המפתח כפי שהיא", "start_time": 123 }] }
כללים: השתמש בכל נקודות המפתח שקיבלת, אחת לכל אחת. start_time חייב להיות אחד מהזמנים שניתנו לך. מיין את הרשימה לפי start_time עולה. אל תמציא נקודות חדשות ואל תשנה את ניסוח נקודות המפתח. בלי markdown, בלי הסברים.`;

const HEADING_PREVIEW_WORDS = 120;

export const generateKeyPointHeadings = (mediaId) =>
  withExclusive(
    `key-point-headings:${mediaId}`,
    () => runGenerateKeyPointHeadings(mediaId),
    "Heading generation is already running for this media"
  );

const runGenerateKeyPointHeadings = async (mediaId) => {
  logger.debug(`[BE:svc] generateKeyPointHeadings mediaId=${mediaId}`);
  const transcript = await pool.query(
    "SELECT ai_key_points FROM transcripts WHERE media_id=$1",
    [mediaId]
  );
  if (transcript.rows.length === 0) throw notFound("Transcript not found", ERROR_CODES.TRANSCRIPT_NOT_FOUND);

  const chunks = await pool.query(
    "SELECT start_time, end_time, content FROM transcript_chunks WHERE media_id=$1 ORDER BY chunk_index",
    [mediaId]
  );
  if (chunks.rows.length === 0) throw badRequest("No transcript content yet — run transcription first", ERROR_CODES.NO_TRANSCRIPT_CONTENT);

  const rawText = chunks.rows.map((r) => r.content).join("\n\n");
  const totalWords = rawText.split(/\s+/).length;
  const warrantedMin = keyPointRange(totalWords).min;

  let keyPoints = transcript.rows[0].ai_key_points;
  // (Re)generate key points from the existing chunks — no re-transcription — when
  // they're missing (the auto step failed) OR there are too few for the length.
  // The second case covers transcripts whose points were made before the count
  // became length-adaptive: e.g. a 3-hour lecture stuck at 3 points gets ~12.
  if (!Array.isArray(keyPoints) || keyPoints.length < warrantedMin) {
    logger.debug(`[BE:svc] generateKeyPointHeadings mediaId=${mediaId} — key points ${keyPoints?.length ?? 0} < ${warrantedMin}, re-analysing transcript`);
    const analysis = await analyzeTranscript(rawText);
    keyPoints = Array.isArray(analysis.key_points) ? analysis.key_points : [];
    if (keyPoints.length === 0) throw badRequest("AI analysis produced no key points", ERROR_CODES.NO_KEY_POINTS);
    // Leave the status alone while the LLM job is still in flight. This path
    // regenerates the analysis on demand, and marking it 'done' underneath a
    // running job would stop the client polling just before that job writes its
    // own summary — reintroducing exactly the gap 'analyzing' was added to
    // close. Otherwise this call *is* what produced the analysis, so 'done' is
    // correct, including recovering a transcript left at 'error'.
    await pool.query(
      `UPDATE transcripts SET
         ai_summary=$1,
         ai_key_points=$2,
         status = CASE WHEN status = 'analyzing' THEN status ELSE 'done' END,
         updated_at=NOW()
       WHERE media_id=$3`,
      [analysis.summary, JSON.stringify(keyPoints), mediaId]
    );
    logger.debug(`[BE:svc] generateKeyPointHeadings mediaId=${mediaId} ✓ generated ${keyPoints.length} key points`);
  }

  const validStarts = chunks.rows.map((c) => c.start_time);
  const endByStart = new Map(chunks.rows.map((c) => [c.start_time, c.end_time]));
  // Snap a model-provided time to the nearest real chunk start, so a slightly
  // off number still lands on a known position.
  const snapToChunk = (t) =>
    validStarts.reduce((best, s) => (Math.abs(s - t) < Math.abs(best - t) ? s : best), validStarts[0]);

  // Trim each chunk to its opening words — enough for GPT to recognise the
  // topic without spending tokens on the full text of a multi-hour lecture.
  const chunkView = chunks.rows
    .map((r) => {
      const preview = r.content.split(/\s+/).slice(0, HEADING_PREVIEW_WORDS).join(" ");
      return `[start_time=${r.start_time}] ${preview}`;
    })
    .join("\n\n");

  const userContent = `נקודות מפתח:\n${keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n\nקטעי התמלול:\n${chunkView}`;

  logger.debug(`[BE:svc] generateKeyPointHeadings mediaId=${mediaId} — ${keyPoints.length} key points over ${chunks.rows.length} chunks → GPT-4o`);
  const response = await openai.chat.completions.create({
    model: GPT_MODEL,
    messages: [
      { role: "system", content: HEADINGS_PROMPT },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
  });

  const parsed = completionJson(response, "generateKeyPointHeadings");
  const headings = Array.isArray(parsed.headings) ? parsed.headings : [];

  // Keep only well-formed entries, snapping each to a real chunk start.
  const valid = headings
    .filter((h) => h && typeof h.title === "string" && h.title.trim() && Number.isFinite(Number(h.start_time)))
    .map((h) => ({ title: h.title.trim(), start: snapToChunk(Math.floor(Number(h.start_time))) }));

  // Timestamps only have chunk-level resolution, so several key points can land
  // on the same chunk → identical times. Group by chunk and spread each group
  // evenly across that chunk's [start, end] window so no two headings share a
  // time (this is the "same time twice" bug).
  const byChunk = new Map();
  for (const v of valid) {
    if (!byChunk.has(v.start)) byChunk.set(v.start, []);
    byChunk.get(v.start).push(v.title);
  }

  const clean = [];
  for (const [start, titles] of byChunk) {
    const end = endByStart.get(start) ?? start;
    const span = Math.max(0, end - start);
    titles.forEach((title, i) => {
      const offset = titles.length > 1 ? Math.floor((span * i) / titles.length) : 0;
      clean.push({ title, start_time: start + offset });
    });
  }
  clean.sort((a, b) => a.start_time - b.start_time);

  // Final guard: force strictly-increasing times so even a degenerate case
  // (chunk with zero span, or rounding collisions) can't produce duplicates.
  for (let i = 1; i < clean.length; i++) {
    if (clean[i].start_time <= clean[i - 1].start_time) {
      clean[i].start_time = clean[i - 1].start_time + 1;
    }
  }

  const result = await pool.query(
    "UPDATE transcripts SET ai_key_point_headings=$1, updated_at=NOW() WHERE media_id=$2 RETURNING *",
    [JSON.stringify(clean), mediaId]
  );
  logger.debug(`[BE:svc] generateKeyPointHeadings mediaId=${mediaId} ✓ ${clean.length} headings saved`);
  return result.rows[0];
};
