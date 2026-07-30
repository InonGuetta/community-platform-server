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
