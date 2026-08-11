// @ts-check
// Correcting Yiddish-accented Hebrew in a finished transcript, on demand.
//
// Nothing else in the pipeline depends on this and it depends on nothing else
// here — it reads the transcript, rewrites it and saves it back to edited_text.
import { pool } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { withExclusive } from "../../lib/inFlight.js";
import { completionText } from "../../lib/openaiClient.js";
import { notFound, badRequest, ERROR_CODES } from "../../lib/AppError.js";
import { openai, GPT_MODEL } from "./gpt.js";

// Yiddish-accented Hebrew confuses Whisper (e.g. "תורה"→"תוירו",
// "בית יוסף"→"בסייסף"). This prompt asks GPT to restore standard Hebrew
// using context, without adding/removing content.
const FIX_HEBREW_PROMPT = `שים לב כי התמלול כאן הוא של עברית אך הדובר הוא דובר עם הגייה של דובר יידיש, ולכן יש מילים שתומללו באופן לא מובן — למשל המילה "תורה" תומללה כ"תוירו", או "בית יוסף" כ"בסייסף", וכדומה.
התפקיד שלך הוא לקבל את הטקסט ולתקן אותו לעברית תקנית — כלומר למה שהכי סביר שזו המילה שנאמרה, בהתחשב בהקשר.
אל תוסיף, תשמיט או תסכם תוכן — רק תקן את האיות והמילים המשובשות. שמור על מבנה הפסקאות. החזר רק את הטקסט המתוקן, בלי הקדמות.`;

// Correct in word-batches so each GPT response stays within output token
// limits (a 3-hour lecture is ~27k words, far past one response). Each batch
// carries enough local context to disambiguate the Yiddish-isms.
const FIX_BATCH_WORDS = 2500;

const correctTextBatch = async (text) => {
  const response = await openai.chat.completions.create({
    model: GPT_MODEL,
    messages: [
      { role: "system", content: FIX_HEBREW_PROMPT },
      { role: "user", content: text },
    ],
  });
  return completionText(response, "fixHebrewTranscript");
};

export const fixHebrewTranscript = (mediaId) =>
  withExclusive(
    `fix-hebrew:${mediaId}`,
    () => runFixHebrewTranscript(mediaId),
    "Hebrew correction is already running for this media"
  );

const runFixHebrewTranscript = async (mediaId) => {
  logger.debug(`[BE:svc] fixHebrewTranscript mediaId=${mediaId}`);
  const existing = await pool.query("SELECT edited_text FROM transcripts WHERE media_id=$1", [mediaId]);
  if (existing.rows.length === 0) throw notFound("Transcript not found", ERROR_CODES.TRANSCRIPT_NOT_FOUND);

  const chunks = await pool.query(
    "SELECT content FROM transcript_chunks WHERE media_id=$1 ORDER BY chunk_index",
    [mediaId]
  );
  const sourceText = existing.rows[0].edited_text || chunks.rows.map((r) => r.content).join("\n\n");
  if (!sourceText.trim()) throw badRequest("No transcript text to correct", ERROR_CODES.NO_TRANSCRIPT_TEXT);

  const words = sourceText.split(/\s+/);
  const batches = [];
  for (let i = 0; i < words.length; i += FIX_BATCH_WORDS) {
    batches.push(words.slice(i, i + FIX_BATCH_WORDS).join(" "));
  }
  logger.debug(`[BE:svc] fixHebrewTranscript mediaId=${mediaId} — ${words.length} words in ${batches.length} batch(es)`);

  const corrected = [];
  for (let i = 0; i < batches.length; i++) {
    logger.debug(`[BE:svc] fixHebrewTranscript batch ${i + 1}/${batches.length} → GPT-4o`);
    corrected.push(await correctTextBatch(batches[i]));
  }
  const correctedText = corrected.join("\n\n");

  const result = await pool.query(
    "UPDATE transcripts SET edited_text=$1, updated_at=NOW() WHERE media_id=$2 RETURNING *",
    [correctedText, mediaId]
  );
  logger.debug(`[BE:svc] fixHebrewTranscript mediaId=${mediaId} ✓ saved ${correctedText.length} chars`);
  return result.rows[0];
};
