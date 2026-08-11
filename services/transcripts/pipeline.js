// @ts-check
// Getting work onto the queues, and noticing when it never got there.
//
// The only module here that talks to Redis. Everything above it is GPT or SQL;
// this is where a media item becomes a job.
import { pool } from "../../db/pool.js";
import { transcriptionQueue } from "../../queue/transcriptionQueue.js";
import { llmQueue } from "../../queue/llmQueue.js";
import { isExtractableText } from "../../lib/mediaFormats.js";
import { logger } from "../../lib/logger.js";
import { withExclusive } from "../../lib/inFlight.js";
import { notFound, badRequest, conflict, ERROR_CODES } from "../../lib/AppError.js";

export const triggerPipeline = async (mediaId) => {
  logger.debug(`[BE:svc] triggerPipeline mediaId=${mediaId} → look up media`);
  const media = await pool.query(
    "SELECT id, s3_key, media_type FROM media_items WHERE id=$1",
    [mediaId]
  );
  if (media.rows.length === 0) {
    logger.debug(`[BE:svc] triggerPipeline mediaId=${mediaId} ✗ media not found`);
    throw notFound("Media not found", ERROR_CODES.MEDIA_NOT_FOUND);
  }

  const { s3_key: s3Key, media_type: mediaType } = media.rows[0];
  const isText = mediaType === "text";

  // Documents skip transcription entirely and go straight to the LLM queue,
  // whose worker extracts the text and then summarises it. Refusing a format we
  // cannot read HERE — before a row is written or a job queued — is what turns
  // "the summary silently never appeared" into an error the lecturer sees the
  // instant they press the button.
  if (isText && !isExtractableText(s3Key)) {
    logger.debug(`[BE:svc] triggerPipeline mediaId=${mediaId} ✗ unsupported text format ${s3Key}`);
    // English, like every other message here: the code is what the client keys
    // its Hebrew on, so the server has no reason to hold a translation. This one
    // was the last Hebrew string on this path and predates the code contract.
    // (The worker's "no readable text" AppError stays Hebrew on purpose — that
    // one is stored in transcripts.error_message and rendered to the user
    // verbatim from the database, with no code anywhere near it.)
    throw badRequest(
      "Cannot summarise a file of this type. Supported: PDF, DOCX, TXT.",
      ERROR_CODES.UNSUPPORTED_TEXT_FORMAT
    );
  }

  const queue = isText ? llmQueue : transcriptionQueue;
  const label = isText ? "Summary" : "Transcription";
  logger.debug(`[BE:svc] triggerPipeline mediaId=${mediaId} type=${mediaType} s3Key=${s3Key} queue=${isText ? "llm" : "transcription"}`);

  // A fixed job id per media item is what stops a double-click from paying for
  // two full transcriptions. Bull ignores an add() whose id already exists.
  //
  // The catch: finished jobs are now retained (removeOnComplete keeps a window),
  // so the id stays taken after a successful run and a legitimate re-trigger
  // would be silently swallowed. So inspect it first — refuse while the job is
  // still live, and clear a finished one to free the id for a fresh run.
  //
  // The id is scoped per queue, so a document's `media:7` and a lecture's
  // `media:7` never collide — they are different queues and cannot both apply
  // to the same media item anyway.
  const jobId = `media:${mediaId}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (["active", "waiting", "delayed"].includes(state)) {
      logger.debug(`[BE:svc] triggerPipeline mediaId=${mediaId} ✗ already ${state}`);
      throw conflict(`${label} is already running for this media`, ERROR_CODES.ALREADY_QUEUED);
    }
    await existing.remove();
  }

  // error_message is cleared alongside the status: a stale "this file is a scan"
  // must not sit next to a fresh run that is still in progress.
  await pool.query(
    `INSERT INTO transcripts (media_id, status) VALUES ($1, 'pending')
     ON CONFLICT (media_id) DO UPDATE SET status='pending', error_message=NULL, updated_at=NOW()`,
    [mediaId]
  );
  logger.debug(`[BE:svc] triggerPipeline mediaId=${mediaId} ✓ row set to 'pending'`);

  const job = await queue.add({ mediaId, s3Key }, { jobId });
  logger.debug(`[BE:svc] triggerPipeline mediaId=${mediaId} ✓ job queued id=${job.id}`);
  return { queued: true, mediaId, jobId: job.id };
};

// ── Reconciliation ───────────────────────────────────────────────────────────
// Media that should have a transcript but has nothing to show for it.
//
// triggerPipeline talks to Redis (getJob) BEFORE it writes the 'pending' row, so
// a trigger issued while the queue is down leaves no trace at all: no row, no
// job, and nothing in the UI to say a transcription was ever asked for. That is
// how an upload sat untranscribed for two days without anyone noticing.
//
// Deliberately narrow — only the two states that are unambiguously stranded:
//   * no transcripts row at all
//   * a row at 'pending' with no live job (the trigger died between the INSERT
//     and the add(), or the job vanished with the queue's Redis data)
// 'processing' is left alone: another worker may legitimately be on it, and
// re-queuing would pay for the same audio twice. 'error' is left alone too —
// that job already ran and was already billed, and retrying it automatically on
// every reconnect would re-buy the same failure on a loop. Both stay behind the
// lecturer's deliberate press of "הפעל תמלול".
//
// media_type='text' is excluded DELIBERATELY, and this is now a cost decision
// rather than a limitation. Books have no transcripts row until someone asks for
// a summary, so including them here would make every Redis reconnect look at an
// entire library of documents that have "no usable transcript" and queue a paid
// LLM run for each one. Summarising a book stays behind an explicit press.
const stranded = `
  SELECT m.id
  FROM media_items m
  LEFT JOIN transcripts t ON t.media_id = m.id
  WHERE m.media_type <> 'text'
    AND (t.media_id IS NULL OR t.status = 'pending')
  ORDER BY m.id`;

// Each queued job is a real Whisper bill, so a sweep that suddenly finds a lot
// of work is far more likely to be a mistake (a restored backup, a bad
// migration) than a genuine backlog. Queue a bounded batch and say what was
// held back; the next reconnect picks up where this left off.
const MAX_RECONCILE_PER_RUN = Number(process.env.MAX_RECONCILE_PER_RUN) || 10;

// getJob/add have no timeout of their own: if Redis disappears mid-sweep they
// hang indefinitely instead of rejecting, which would strand the exclusive lock
// and silently disable every future reconcile until the worker restarts — in a
// feature whose whole point is surviving exactly that. Bound the wait so a queue
// that dies underneath us costs one skipped item, not all of them. The abandoned
// call is still observed by the race, so its late rejection is never unhandled.
const TRIGGER_TIMEOUT_MS = 10_000;

const triggerWithTimeout = (mediaId) => {
  let timer;
  return Promise.race([
    triggerPipeline(mediaId),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("queue did not respond in time")), TRIGGER_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
};

export const reconcileMissingTranscripts = () =>
  withExclusive(
    "reconcile-transcripts",
    runReconcileMissingTranscripts,
    "Reconciliation is already running"
  );

const runReconcileMissingTranscripts = async () => {
  const { rows } = await pool.query(stranded);
  if (rows.length === 0) return { found: 0, queued: [], skipped: [], deferred: 0 };

  const batch = rows.slice(0, MAX_RECONCILE_PER_RUN);
  const deferred = rows.length - batch.length;
  logger.info(`[BE:svc] reconcile — ${rows.length} media without a usable transcript, taking ${batch.length}`);

  const queued = [];
  const skipped = [];
  for (const { id } of batch) {
    try {
      // Reuse the real trigger rather than re-implementing it: it owns the job
      // id convention, the 'already running' check and the 'pending' write, and
      // a second copy of that logic here is exactly how the two drift apart.
      await triggerWithTimeout(id);
      queued.push(id);
    } catch (err) {
      // One unqueueable item must not abandon the rest of the sweep. A conflict
      // is the normal, healthy outcome — the job is already live.
      skipped.push({ mediaId: id, reason: err.message });
      logger.debug(`[BE:svc] reconcile mediaId=${id} skipped — ${err.message}`);
    }
  }

  logger.info(
    `[BE:svc] reconcile ✓ queued ${queued.length}${queued.length ? ` (media ${queued.join(", ")})` : ""}` +
    `${skipped.length ? `, skipped ${skipped.length}` : ""}` +
    `${deferred ? `, ${deferred} left for the next run` : ""}`
  );
  return { found: rows.length, queued, skipped, deferred };
};
