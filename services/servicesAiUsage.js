// @ts-check
// What the platform spends on OpenAI (PRD ADM-1) and the monthly cap on it
// (NFR-3). Migration 040 explains the table.
//
// Every call is recorded by the metered client (lib/openaiClient.js →
// meterOpenAI), never by its caller, so a new call site cannot forget to.
//
// A service, not a lib module, because it reads and writes the database — and
// only services touch the pool (CLAUDE.md).
import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { env } from "../lib/env.js";
import { AppError, ERROR_CODES } from "../lib/AppError.js";

// ── Prices ──────────────────────────────────────────────────────────────────
//
// US dollars, OpenAI's list prices for the models this server uses: per million
// tokens for the text models, per minute of audio for Whisper. The cost of a
// call is computed from these when it is RECORDED and stored with it, so a
// price changed here later does not rewrite what an earlier month cost.
//
// An ESTIMATE: it is what the usage OpenAI reported comes to at list price, not
// the invoice. A model missing from this table is recorded with its usage and a
// cost of 0, and logged once — the screen still shows the calls.
export const PRICES = Object.freeze({
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "whisper-1": { perMinute: 0.006 },
});

const warnedModels = new Set();

/**
 * @param {{ model: string, inputTokens?: number, outputTokens?: number, audioSeconds?: number }} usage
 * @returns {number} US dollars
 */
export const costOf = ({ model, inputTokens = 0, outputTokens = 0, audioSeconds = 0 }) => {
  // A dated snapshot ("gpt-4o-2024-08-06") is billed as its family.
  const key = Object.keys(PRICES).find((name) => model === name || model?.startsWith(`${name}-20`));
  const price = key ? PRICES[key] : null;
  if (!price) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      logger.warn(`[ai-usage] no price for model "${model}" — its calls are recorded at $0`);
    }
    return 0;
  }
  if ("perMinute" in price) return (audioSeconds / 60) * price.perMinute;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
};

/**
 * Record one call. Never throws: the call it describes has already happened,
 * and a failure to write its cost must not fail the work it paid for.
 *
 * @param {{ purpose: string, model: string, inputTokens?: number, outputTokens?: number, audioSeconds?: number }} usage
 */
export const recordAiUsage = async (usage) => {
  try {
    await pool.query(
      `INSERT INTO ai_usage (purpose, model, input_tokens, output_tokens, audio_seconds, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        usage.purpose,
        usage.model || "unknown",
        Math.round(usage.inputTokens ?? 0),
        Math.round(usage.outputTokens ?? 0),
        usage.audioSeconds ?? 0,
        costOf(usage),
      ]
    );
  } catch (err) {
    logger.warn(`[ai-usage] could not record a ${usage.purpose} call: ${err.message}`);
  }
};

// ── The month ───────────────────────────────────────────────────────────────
//
// A month in Israel's zone, like every date the platform shows: a call at 01:00
// on the 1st belongs to the new month here, though it is the 31st in UTC.
const MONTH_START_SQL = "date_trunc('month', NOW() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem'";

/** US dollars spent so far this month. */
export const monthSpendUsd = async () => {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(cost_usd), 0)::float AS spent FROM ai_usage WHERE created_at >= ${MONTH_START_SQL}`
  );
  return Number(rows[0]?.spent ?? 0);
};

/**
 * The admin's screen: this month by purpose, and by day.
 */
export const monthUsageReport = async () => {
  const [byPurpose, byDay, spent] = await Promise.all([
    pool.query(
      `SELECT purpose,
              COUNT(*)::int AS calls,
              COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
              COALESCE(SUM(audio_seconds), 0)::float AS audio_seconds,
              COALESCE(SUM(cost_usd), 0)::float AS cost_usd
       FROM ai_usage WHERE created_at >= ${MONTH_START_SQL}
       GROUP BY purpose ORDER BY cost_usd DESC`
    ),
    pool.query(
      `SELECT to_char(created_at AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD') AS day,
              COALESCE(SUM(cost_usd), 0)::float AS cost_usd
       FROM ai_usage WHERE created_at >= ${MONTH_START_SQL}
       GROUP BY 1 ORDER BY 1`
    ),
    monthSpendUsd(),
  ]);
  return {
    spentUsd: spent,
    capUsd: env.aiMonthlyCapUsd,
    byPurpose: byPurpose.rows.map((r) => ({ ...r, input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens) })),
    byDay: byDay.rows,
  };
};

/**
 * The cap (NFR-3): refuse NEW processing once this month's spend has reached
 * AI_MONTHLY_CAP_USD. Called before a job is queued — never inside one, so work
 * already started is finished rather than abandoned half-paid-for. The chat is
 * not capped here: it has its own daily quota, and a reader asking about a
 * lesson already processed costs little next to processing a new one.
 *
 * No cap set: does nothing, and asks the database nothing.
 */
export const assertWithinAiBudget = async () => {
  const cap = env.aiMonthlyCapUsd;
  if (cap === null) return;
  const spent = await monthSpendUsd();
  if (spent >= cap) {
    throw new AppError(
      `This month's AI budget ($${cap}) has been reached`,
      429,
      ERROR_CODES.AI_BUDGET_EXCEEDED
    );
  }
};
