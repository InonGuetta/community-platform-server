import "dotenv/config";
import { llmQueue } from "../llmQueue.js";
import { pool } from "../../db/pool.js";
import {
  analyzeTranscript,
  getTranscriptText,
  saveTextChunks,
  MAX_KEY_POINTS_TEXT,
} from "../../services/servicesTranscripts.js";
import { embedChunksForMedia } from "../../services/servicesEmbeddings.js";
import { extractDocumentText } from "../../lib/textExtract.js";
import { readMediaBuffer } from "../../lib/storage.js";
import { AppError } from "../../lib/AppError.js";
import { logger } from "../../lib/logger.js";
import { installWorkerLifecycle, installQueueErrorLogging } from "./workerLifecycle.js";

// This worker now serves two sources that converge on the same job:
//
//   audio/video — the transcription worker has already written the chunks and
//                 queues this to produce the summary. Unchanged.
//   text        — triggerPipeline queues it directly. There is nothing in the
//                 database yet, so this worker extracts the document first and
//                 writes the chunks itself, then follows the identical
//                 analysis path.
//
// Text extraction lives here rather than in a third worker deliberately.
// Parsing a document is fast and CPU-light — nothing like ffmpeg + Whisper — so
// a dedicated process would add a thing to deploy, monitor and restart in
// exchange for nothing. The real cost of this choice is that a long book
// occupies the single LLM worker while it runs, delaying a lecture's summary
// behind it; if that ever bites, this stage moves to its own queue without
// touching anything else.

// Ensure the media item has chunks to analyse, extracting the document first if
// it is a text item that has none. Returns { text, isText }.
//
// isText comes from the media row rather than from the job payload's shape: the
// payload is written by two different callers and is replayed from Redis for
// jobs queued by older versions, so it is not something to infer a code path
// from. The database always knows.
const prepareText = async (mediaId) => {
  const media = await pool.query(
    "SELECT media_type, s3_key FROM media_items WHERE id=$1",
    [mediaId]
  );
  if (media.rows.length === 0) {
    throw new AppError(`Media ${mediaId} no longer exists`, 404);
  }
  const { media_type: mediaType, s3_key: s3Key } = media.rows[0];

  if (mediaType !== "text") {
    // Audio/video: the transcription worker already saved the chunks. Read from
    // the DB rather than the job body — jobs queued by an older worker still
    // carry rawText; it is ignored, and reading the chunks gives the same text,
    // so both shapes work.
    const rawText = await getTranscriptText(mediaId);
    if (!rawText.trim()) throw new Error(`No transcript chunks found for mediaId=${mediaId}`);
    return { text: rawText, isText: false };
  }

  // Skip re-extraction when the chunks are already there. This is what makes a
  // Bull retry cheap: attempt two re-runs only the analysis that failed, rather
  // than downloading and re-parsing the whole book to arrive at the same text.
  const existing = await getTranscriptText(mediaId);
  if (existing.trim()) {
    logger.debug(`[WORKER:llm] text mediaId=${mediaId} — chunks already present, skipping extraction`);
    return { text: existing, isText: true };
  }

  await pool.query(
    "UPDATE transcripts SET status='processing', updated_at=NOW() WHERE media_id=$1",
    [mediaId]
  );

  logger.debug(`[WORKER:llm] text mediaId=${mediaId} — reading ${s3Key}`);
  const buffer = await readMediaBuffer(s3Key);

  logger.debug(`[WORKER:llm] text mediaId=${mediaId} — extracting (${(buffer.length / 1024 / 1024).toFixed(2)}MB)`);
  const { text, words, pageCount, extension } = await extractDocumentText(buffer, s3Key);
  logger.info(`[WORKER:llm] text mediaId=${mediaId} ✓ extracted ${words} words from ${pageCount || "?"} page(s) (.${extension})`);

  const chunkCount = await saveTextChunks(mediaId, text);
  if (chunkCount === 0) throw new AppError("לא נמצא טקסט קריא בקובץ.", 400);

  await pool.query(
    "UPDATE transcripts SET status='analyzing', updated_at=NOW() WHERE media_id=$1",
    [mediaId]
  );

  // Best-effort, exactly as on the audio path: the chunks are already saved and
  // searchable by keyword, and a missed embedding is recoverable later by the
  // backfill script (which only touches rows WHERE embedding IS NULL).
  try {
    const embedded = await embedChunksForMedia(mediaId);
    logger.debug(`[WORKER:llm] text mediaId=${mediaId} ✓ embedded ${embedded} chunk(s)`);
  } catch (embedErr) {
    logger.error(`[WORKER:llm] ⚠ embedding failed (non-fatal) mediaId=${mediaId} — ${embedErr.message}`);
  }

  return { text, isText: true };
};

llmQueue.process(async (job) => {
  const { mediaId } = job.data;
  const t0 = Date.now();
  logger.info(`[WORKER:llm] ── job picked up jobId=${job.id} mediaId=${mediaId}`);

  try {
    const { text: rawText, isText } = await prepareText(mediaId);
    logger.debug(`[WORKER:llm] step 1/2 — analysing (${rawText.length} chars)`);
    // analyzeTranscript folds long input repeatedly so no single call exceeds
    // the TPM limit — the bug that silently broke multi-hour audio, and the one
    // a 400-page book would hit far harder.
    const parsed = await analyzeTranscript(rawText, isText ? MAX_KEY_POINTS_TEXT : undefined);
    logger.debug(`[WORKER:llm] step 1/2 ✓ summary=${parsed.summary?.length}ch keyPoints=${parsed.key_points?.length}`);

    // Chapters are no longer auto-generated. The transcript view shows a single
    // "subheadings by key points" block that the user produces on demand from
    // the key points below — so we only persist summary + key_points here.
    logger.debug(`[WORKER:llm] step 2/2 — updating transcripts row`);
    // status='done' lands together with the summary, so the row is never
    // advertised as finished before the content it promises exists.
    await pool.query(
      `UPDATE transcripts SET
        ai_summary=$1,
        ai_key_points=$2,
        status='done',
        error_message=NULL,
        updated_at=NOW()
       WHERE media_id=$3`,
      [
        parsed.summary,
        JSON.stringify(parsed.key_points),
        mediaId,
      ]
    );
    logger.info(`[WORKER:llm] ── DONE mediaId=${mediaId} total=${Date.now() - t0}ms`);
  } catch (err) {
    logger.error(`[WORKER:llm] ✗ FAILED mediaId=${mediaId} ${Date.now() - t0}ms — ${err.message}`);
    if (err.response?.data) logger.error(`[WORKER:llm]   openai response:`, err.response.data);

    // An AppError from the extraction stage is a permanent problem with the
    // FILE — a scan with no text layer, a .doc, an encrypted PDF. Retrying it
    // three times over three minutes re-reads the same bytes to reach the same
    // conclusion, so discard the job and keep the reason. Anything else (an
    // OpenAI blip, a dropped DB connection) is transient and keeps its retries.
    const permanent = err instanceof AppError;
    if (permanent) {
      job.discard();
      logger.warn(`[WORKER:llm]   permanent failure — not retrying: ${err.message}`);
    }

    // Make the failure visible instead of leaving the row stuck at 'analyzing'
    // with no summary — that "silent success" is what hid the broken long-audio
    // case. status='error' signals the AI step didn't finish, and also stops the
    // client polling for a summary that will never arrive. error_message is what
    // lets the UI say WHY, which for a document is usually something the user
    // can fix.
    await pool.query(
      "UPDATE transcripts SET status='error', error_message=$1, updated_at=NOW() WHERE media_id=$2",
      [permanent ? err.message : null, mediaId]
    ).catch((dbErr) => logger.error(`[WORKER:llm]   could not set status='error':`, dbErr.message));
    throw err;
  }
});

installQueueErrorLogging("llm", llmQueue);
installWorkerLifecycle("llm", llmQueue);

logger.info("[WORKER:llm] LLM worker started, waiting for jobs...");
