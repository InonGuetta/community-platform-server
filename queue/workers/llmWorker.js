import "dotenv/config";
import { llmQueue } from "../llmQueue.js";
import { pool } from "../../db/pool.js";
import { analyzeTranscript, getTranscriptText } from "../../services/servicesTranscripts.js";
import { logger } from "../../lib/logger.js";
import { installWorkerLifecycle } from "./workerLifecycle.js";

llmQueue.process(async (job) => {
  const { mediaId } = job.data;
  const t0 = Date.now();
  logger.info(`[WORKER:llm] ── job picked up jobId=${job.id} mediaId=${mediaId}`);

  try {
    // Read from the DB rather than the job body. Jobs queued by an older worker
    // still carry rawText; it is ignored, and reading the chunks gives the same
    // text, so both shapes work.
    const rawText = await getTranscriptText(mediaId);
    if (!rawText.trim()) throw new Error(`No transcript chunks found for mediaId=${mediaId}`);
    logger.debug(`[WORKER:llm] step 1/2 — analysing transcript (${rawText.length} chars)`);
    // analyzeTranscript handles long lectures via map-reduce so no single call
    // exceeds the TPM limit (the bug that silently broke multi-hour audio).
    const parsed = await analyzeTranscript(rawText);
    logger.debug(`[WORKER:llm] step 1/2 ✓ summary=${parsed.summary?.length}ch keyPoints=${parsed.key_points?.length}`);

    // Chapters are no longer auto-generated. The transcript view shows a single
    // "subheadings by key points" block that the user produces on demand from
    // the key points below — so we only persist summary + key_points here.
    logger.debug(`[WORKER:llm] step 2/2 — updating transcripts row`);
    await pool.query(
      `UPDATE transcripts SET
        ai_summary=$1,
        ai_key_points=$2,
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
    // Make the failure visible instead of leaving status='done' (set by the
    // transcription worker) with no summary — that "silent success" is what hid
    // the broken long-audio case. status='error' signals the AI step didn't finish.
    await pool.query(
      "UPDATE transcripts SET status='error', updated_at=NOW() WHERE media_id=$1",
      [mediaId]
    ).catch((dbErr) => logger.error(`[WORKER:llm]   could not set status='error':`, dbErr.message));
    throw err;
  }
});

llmQueue.on("error", (err) => {
  logger.error(`[WORKER:llm] queue error:`, err.message);
});

installWorkerLifecycle("llm", llmQueue);

logger.info("[WORKER:llm] LLM worker started, waiting for jobs...");
