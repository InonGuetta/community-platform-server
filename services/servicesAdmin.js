// @ts-check
import { pool } from "../db/pool.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);

export const getStats = async () => {
  const [users, media, donations] = await Promise.all([
    pool.query("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_active) AS active FROM users"),
    pool.query("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_published) AS published, media_type, COUNT(*) FILTER (WHERE true) FROM media_items GROUP BY media_type"),
    pool.query("SELECT COALESCE(SUM(amount_cents), 0) AS total_cents, COUNT(*) AS count FROM donations WHERE status='completed'"),
  ]);

  const mediaByType = {};
  media.rows.forEach((r) => { mediaByType[r.media_type] = r.count; });

  return {
    users: { total: Number(users.rows[0].total), active: Number(users.rows[0].active) },
    media: { total: media.rows.reduce((s, r) => s + Number(r.count), 0), byType: mediaByType },
    donations: { totalCents: Number(donations.rows[0].total_cents), count: Number(donations.rows[0].count) },
  };
};

const getQueueCounts = async (queue) => {
  try {
    const [waiting, active, completed, failed] = await withTimeout(
      Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
      ]),
      500
    );
    return { waiting, active, completed, failed };
  } catch {
    return null;
  }
};

export const getQueueStatus = async () => {
  const [transcription, llm] = await Promise.all([
    getQueueCounts(transcriptionQueue),
    getQueueCounts(llmQueue),
  ]);

  return { transcription, llm };
};

// ── What went wrong, and what to do about it ────────────────────────────────

// The failed jobs themselves, not just how many there are.
//
// getQueueStatus has reported a `failed` COUNT since the dashboard was built,
// which tells an admin that something broke and nothing about what. The reason a
// job failed is the whole diagnostic — "ffmpeg failed", "no readable text", an
// OpenAI 429 — and it was sitting in Redis with nothing reading it.
const FAILED_SAMPLE = 20;

const failedFrom = async (queue, label) => {
  try {
    const jobs = await withTimeout(queue.getFailed(0, FAILED_SAMPLE - 1), 1500);
    return jobs.map((job) => ({
      queue: label,
      id: String(job.id),
      mediaId: job.data?.mediaId ?? null,
      attempts: job.attemptsMade,
      failedAt: job.finishedOn ?? null,
      // The message only. A stack from inside a worker is pages long and this
      // goes to a browser; the request id in the server log is how the full one
      // is found.
      reason: String(job.failedReason ?? "").slice(0, 300),
    }));
  } catch {
    // Redis unreachable. null rather than [] so the dashboard can say "cannot
    // reach the queue" instead of "nothing has failed", which are opposite
    // things to tell someone investigating.
    return null;
  }
};

export const getFailedJobs = async () => {
  const [transcription, llm] = await Promise.all([
    failedFrom(transcriptionQueue, "transcription"),
    failedFrom(llmQueue, "llm"),
  ]);
  return { transcription, llm };
};

// Media that should have a transcript and has nothing to show for it.
//
// The DB half of the same question the queues answer: a job that never got
// queued at all leaves no failed job to find, which is precisely the case
// reconcileMissingTranscripts exists for. Shown alongside so an admin can see
// whether pressing it would do anything.
export const getStrandedMedia = async () => {
  const { rows } = await pool.query(
    `SELECT m.id, m.title, m.media_type, t.status, t.error_message, t.updated_at
     FROM media_items m
     LEFT JOIN transcripts t ON t.media_id = m.id
     WHERE m.media_type <> 'text'
       AND (t.media_id IS NULL OR t.status IN ('pending', 'error'))
     ORDER BY t.updated_at DESC NULLS LAST, m.id DESC
     LIMIT 50`
  );
  return rows;
};

export const getSystemHealth = async () => {
  const checks = { db: false, redis: false };

  try {
    await pool.query("SELECT 1");
    checks.db = true;
  } catch {}

  try {
    const client = await withTimeout(transcriptionQueue.client, 500);
    checks.redis = client.status === "ready";
  } catch {}

  return checks;
};
