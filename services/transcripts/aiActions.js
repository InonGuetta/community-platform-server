// @ts-check
// The two on-demand AI actions on a transcript — "תיקון עברית" and "כותרות
// משנה" — as queued work with a status (PRD PIPE-5, NFR-4; migration 039).
//
// The request CLAIMS the action and queues it; the LLM worker RUNS it; the
// page polls the transcript row until the status settles. The work itself is
// unchanged — it is hebrew.js and headings.js, called from the worker instead
// of from a request handler.
import { pool } from "../../db/pool.js";
import { llmQueue } from "../../queue/llmQueue.js";
import { logger } from "../../lib/logger.js";
import { AppError, notFound, badRequest, conflict, ERROR_CODES } from "../../lib/AppError.js";
import { fixHebrewTranscript } from "./hebrew.js";
import { generateKeyPointHeadings } from "./headings.js";

// Each action: the prefix of its three columns (migration 039), the name of its
// job on the LLM queue, the work, and the check that can refuse it at once —
// before anything is claimed or queued — so the button says "nothing to
// correct" now rather than a failure a minute later.
export const AI_ACTIONS = Object.freeze({
  hebrewFix: {
    column: "hebrew_fix",
    jobName: "hebrew-fix",
    run: fixHebrewTranscript,
    precheck: async (mediaId) => {
      const { rows } = await pool.query(
        `SELECT COALESCE(t.edited_text, '') <> ''
                OR EXISTS (SELECT 1 FROM transcript_chunks c WHERE c.media_id = t.media_id) AS has_text
         FROM transcripts t WHERE t.media_id = $1`,
        [mediaId]
      );
      if (rows.length === 0) throw notFound("Transcript not found", ERROR_CODES.TRANSCRIPT_NOT_FOUND);
      if (!rows[0].has_text) throw badRequest("No transcript text to correct", ERROR_CODES.NO_TRANSCRIPT_TEXT);
    },
  },
  headings: {
    column: "headings",
    jobName: "key-point-headings",
    run: generateKeyPointHeadings,
    precheck: async (mediaId) => {
      const { rows } = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM transcript_chunks c WHERE c.media_id = t.media_id) AS has_chunks
         FROM transcripts t WHERE t.media_id = $1`,
        [mediaId]
      );
      if (rows.length === 0) throw notFound("Transcript not found", ERROR_CODES.TRANSCRIPT_NOT_FOUND);
      if (!rows[0].has_chunks) {
        throw badRequest("No transcript content yet — run transcription first", ERROR_CODES.NO_TRANSCRIPT_CONTENT);
      }
    },
  },
});

// A claim older than this is treated as abandoned: the worker that took it
// died, or Redis lost the job, and nothing will ever move the row. Without a
// limit the button would be refused with "already running" forever. Longer
// than the slowest real run — a multi-hour lecture's Hebrew correction is a
// few minutes — by a wide margin.
export const AI_ACTION_STALE_MINUTES = 30;

// How long to wait for Redis to accept the job. With Redis down, Bull does not
// fail an add() — it waits for a connection that is not coming, and the request
// hangs until the browser gives up (seen in practice on 2026-11-01). Five
// seconds is far longer than a healthy add takes.
const QUEUE_ADD_TIMEOUT_MS = 5000;

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`queue add timed out after ${ms}ms`)), ms).unref?.()),
  ]);

/**
 * Claim an action and put it on the LLM queue. Returns the transcript row as
 * it now stands — status 'queued' — for the page to start polling from.
 *
 * The claim is one UPDATE: it succeeds only if the action is not already
 * queued or running (or its claim is stale), so two presses, two tabs or two
 * server processes cannot start it twice.
 *
 * @param {number} mediaId
 * @param {keyof typeof AI_ACTIONS} name
 */
export const requestAiAction = async (mediaId, name) => {
  const action = AI_ACTIONS[name];
  await action.precheck(mediaId);

  const c = action.column;
  const claimed = await pool.query(
    `UPDATE transcripts
     SET ${c}_status = 'queued', ${c}_error = NULL, ${c}_requested_at = NOW()
     WHERE media_id = $1
       AND (${c}_status IS NULL
            OR ${c}_status NOT IN ('queued', 'running')
            OR ${c}_requested_at < NOW() - INTERVAL '${AI_ACTION_STALE_MINUTES} minutes')
     RETURNING *`,
    [mediaId]
  );
  if (claimed.rows.length === 0) {
    throw conflict("This action is already running for this media", ERROR_CODES.ALREADY_QUEUED);
  }

  try {
    // One attempt. A Hebrew correction is a dozen paid calls over the whole
    // lecture; retrying it silently on failure would pay for them again. The
    // user sees the failure and decides.
    await withTimeout(
      llmQueue.add(action.jobName, { mediaId }, { attempts: 1 }),
      QUEUE_ADD_TIMEOUT_MS
    );
  } catch (err) {
    // Release the claim, or the button would say "already running" about work
    // that was never queued.
    await pool.query(`UPDATE transcripts SET ${c}_status = NULL WHERE media_id = $1`, [mediaId]).catch(() => {});
    logger.error(`[BE:svc] requestAiAction ${name} mediaId=${mediaId} — could not queue: ${err.message}`);
    throw new AppError("The processing queue is unavailable. Try again shortly.", 503);
  }

  logger.info(`[BE:svc] requestAiAction ${name} mediaId=${mediaId} ✓ queued`);
  return claimed.rows[0];
};

/**
 * Run a claimed action — called by the LLM worker. Records 'running', then
 * 'done' or 'error'. Rethrows, so Bull records the failure too.
 *
 * The error column holds the CODE of an AppError (NO_KEY_POINTS, …) — the
 * client words codes in Hebrew — and nothing for anything else: an OpenAI or
 * driver message is not the user's to read.
 *
 * @param {number} mediaId
 * @param {keyof typeof AI_ACTIONS} name
 */
export const runAiAction = async (mediaId, name) => {
  const action = AI_ACTIONS[name];
  const c = action.column;
  await pool.query(`UPDATE transcripts SET ${c}_status = 'running' WHERE media_id = $1`, [mediaId]);
  try {
    await action.run(mediaId);
    await pool.query(`UPDATE transcripts SET ${c}_status = 'done', ${c}_error = NULL WHERE media_id = $1`, [mediaId]);
  } catch (err) {
    const code = err instanceof AppError ? err.code ?? null : null;
    await pool.query(
      `UPDATE transcripts SET ${c}_status = 'error', ${c}_error = $2 WHERE media_id = $1`,
      [mediaId, code]
    ).catch((dbErr) => logger.error(`[WORKER:llm] could not record ${name} failure: ${dbErr.message}`));
    throw err;
  }
};
