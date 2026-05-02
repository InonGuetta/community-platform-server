import { pool } from "../db/pool.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

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

export const getQueueStatus = async () => {
  const [transcriptionCounts, llmCounts] = await Promise.all([
    Promise.all([
      transcriptionQueue.getWaitingCount(),
      transcriptionQueue.getActiveCount(),
      transcriptionQueue.getCompletedCount(),
      transcriptionQueue.getFailedCount(),
    ]),
    Promise.all([
      llmQueue.getWaitingCount(),
      llmQueue.getActiveCount(),
      llmQueue.getCompletedCount(),
      llmQueue.getFailedCount(),
    ]),
  ]);

  return {
    transcription: { waiting: transcriptionCounts[0], active: transcriptionCounts[1], completed: transcriptionCounts[2], failed: transcriptionCounts[3] },
    llm: { waiting: llmCounts[0], active: llmCounts[1], completed: llmCounts[2], failed: llmCounts[3] },
  };
};

export const getSystemHealth = async () => {
  const checks = { db: false, redis: false };

  try {
    await pool.query("SELECT 1");
    checks.db = true;
  } catch {}

  try {
    const client = await transcriptionQueue.client;
    checks.redis = client.status === "ready";
  } catch {}

  return checks;
};
