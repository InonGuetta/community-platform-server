// @ts-check
// transcripts.status — the contract with the UI — written here and nowhere else.
//
//     pending → processing → analyzing → done        or  error, from anywhere
//
// The client polls on it, so every transition is a promise to the page:
//
//   pending     a run was asked for (triggerPipeline); nothing has started
//   processing  a worker has picked it up: transcribing, or extracting a book
//   analyzing   the text exists and the summary is being written. It exists
//               because 'done' used to be set before the summary existed, and
//               the page stopped polling for a summary that came a minute later
//   done        written in the SAME statement as the summary, so the row is
//               never advertised as finished before the content it promises
//   error       only on a job's final attempt — written before a retry, it
//               stops the page polling for a run that may still succeed
//
// A row left at 'processing' or 'analyzing' with no job behind it is the
// failure mode to watch for. test/transcriptStatus.test.js fails on a status
// written anywhere but here.
import { pool } from "../../db/pool.js";

/**
 * A run was asked for: creates the row, or resets one from a previous run —
 * clearing its error_message, so a stale "this file is a scan" does not sit
 * next to a run still in progress.
 * @param {number|string} mediaId
 */
export const markPending = (mediaId) =>
  pool.query(
    `INSERT INTO transcripts (media_id, status) VALUES ($1, 'pending')
     ON CONFLICT (media_id) DO UPDATE SET status='pending', error_message=NULL, updated_at=NOW()`,
    [mediaId]
  );

/** A worker has picked the run up. @param {number|string} mediaId */
export const markProcessing = (mediaId) =>
  pool.query("UPDATE transcripts SET status='processing', updated_at=NOW() WHERE media_id=$1", [mediaId]);

/**
 * The text exists; the summary is being written. A book's readable share
 * (migration 033) is recorded in the same statement when given — null
 * included — so the page that sees 'analyzing' already sees the quality.
 * @param {number|string} mediaId
 * @param {{ textQuality?: number|null }} [options]
 */
export const markAnalyzing = (mediaId, options = {}) =>
  "textQuality" in options
    ? pool.query(
        "UPDATE transcripts SET status='analyzing', text_quality=$2, updated_at=NOW() WHERE media_id=$1",
        [mediaId, options.textQuality]
      )
    : pool.query("UPDATE transcripts SET status='analyzing', updated_at=NOW() WHERE media_id=$1", [mediaId]);

/**
 * Finished: the summary and key points, and 'done' with them. Clears any
 * error_message a previous attempt left.
 * @param {number|string} mediaId
 * @param {{ summary: string, keyPoints: unknown[] }} analysis
 */
export const markDone = (mediaId, { summary, keyPoints }) =>
  pool.query(
    `UPDATE transcripts SET
        ai_summary=$1,
        ai_key_points=$2,
        status='done',
        error_message=NULL,
        updated_at=NOW()
       WHERE media_id=$3`,
    [summary, JSON.stringify(keyPoints), mediaId]
  );

/**
 * An analysis produced on demand (the headings feature re-analysing a
 * transcript whose key points are too few): 'done', unless the pipeline's own
 * summary job is still running — marking it done underneath that job would
 * stop the page polling just before the job writes its summary. Recovers a row
 * left at 'error'.
 * @param {number|string} mediaId
 * @param {{ summary: string, keyPoints: unknown[] }} analysis
 */
export const markDoneUnlessAnalyzing = (mediaId, { summary, keyPoints }) =>
  pool.query(
    `UPDATE transcripts SET
         ai_summary=$1,
         ai_key_points=$2,
         status = CASE WHEN status = 'analyzing' THEN status ELSE 'done' END,
         updated_at=NOW()
       WHERE media_id=$3`,
    [summary, JSON.stringify(keyPoints), mediaId]
  );

/**
 * Failed for good — call only on the job's final attempt. `errorMessage`, when
 * given (null included), replaces the stored reason: the text the page shows
 * for a problem with the file itself, which the lecturer can fix. Omitted, the
 * stored reason is left as it is.
 * @param {number|string} mediaId
 * @param {{ errorMessage?: string|null }} [options]
 */
export const markFailed = (mediaId, options = {}) =>
  "errorMessage" in options
    ? pool.query(
        "UPDATE transcripts SET status='error', error_message=$1, updated_at=NOW() WHERE media_id=$2",
        [options.errorMessage, mediaId]
      )
    : pool.query("UPDATE transcripts SET status='error', updated_at=NOW() WHERE media_id=$1", [mediaId]);
