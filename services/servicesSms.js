// @ts-check
// Sending an SMS as the platform does it: under the monthly cap, and recorded.
//
// lib/sms.js transmits; this decides whether a message may go and writes down
// what it cost (sms_usage, migration 054), the way services/servicesAiUsage.js
// does for OpenAI. Every SMS the server sends goes through `sendSms` — a
// verification code and a notification alike — so the cap and the admin's
// screen see all of them.
//
// sms_usage holds a hash of the number, never the number: enough to count the
// codes sent to one number in an hour (the verification rate limit), nothing a
// leaked table would give away.
import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { env } from "../lib/env.js";
import { transmitSms } from "../lib/sms.js";
import { phoneHash } from "../lib/phone.js";

// The month in Israel's zone, as servicesAiUsage.js counts it.
const MONTH_START_SQL = "date_trunc('month', NOW() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem'";

/** US dollars spent on SMS so far this month. */
export const monthSmsSpendUsd = async () => {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(cost_usd), 0)::float AS spent FROM sms_usage WHERE created_at >= ${MONTH_START_SQL}`
  );
  return Number(rows[0]?.spent ?? 0);
};

/** Whether this month's SMS spend has reached SMS_MONTHLY_CAP_USD. No cap: false, without a query. */
export const smsBudgetReached = async () => {
  const cap = env.smsMonthlyCapUsd;
  if (cap === null) return false;
  return (await monthSmsSpendUsd()) >= cap;
};

// ── Recording ───────────────────────────────────────────────────────────────
//
// A message's row is written BEFORE it is sent, as 'sending', and settled
// after. A row written only afterwards would leave every message in flight out
// of the counts the verification limits read — and two requests a moment apart
// would both find room for one more code.

/**
 * Reserve a message's row. `db` is the pool, or a transaction's client when the
 * reservation must be decided together with other statements (servicesPhone's
 * send limits).
 * @param {{ query: Function }} db
 * @param {{ userId: number | null, to: string, purpose: string }} message
 * @returns {Promise<number>} the row's id
 */
export const reserveSms = async (db, { userId, to, purpose }) => {
  const { rows } = await db.query(
    `INSERT INTO sms_usage (user_id, purpose, phone_hash, segments, cost_usd, status)
     VALUES ($1, $2, $3, 0, 0, 'sending') RETURNING id`,
    [userId, purpose.slice(0, 32), phoneHash(to)]
  );
  return rows[0].id;
};

/**
 * Write what happened to a reserved message. Never throws: the message has
 * already gone (or failed), and a failure to write it down must not fail the
 * work that sent it.
 * @param {number | null} id
 * @param {{ status: string, segments: number }} result
 */
const settleSms = async (id, { status, segments }) => {
  if (id === null) return;
  // Only a message the provider accepted costs anything; a logged one is free.
  const cost = status === "sent" ? segments * env.smsPricePerSegmentUsd : 0;
  try {
    await pool.query(
      "UPDATE sms_usage SET status = $2, segments = $3, cost_usd = $4 WHERE id = $1",
      [id, status, segments, cost]
    );
  } catch (err) {
    logger.warn(`[sms] could not record message ${id}: ${err.message}`);
  }
};

/**
 * Transmit a message already reserved, and settle its row.
 * @param {number | null} id from reserveSms
 * @param {{ to: string, body: string }} message
 */
export const transmitReserved = async (id, { to, body }) => {
  const result = await transmitSms({ to, body });
  await settleSms(id, result);
  return result;
};

/** Fail closed: a cap that cannot be read is treated as reached. */
const capRefusal = async (purpose) => {
  try {
    if (!(await smsBudgetReached())) return null;
    logger.warn(`[sms] monthly cap reached — a ${purpose} message was not sent`);
    return /** @type {const} */ ({ status: "capped", segments: 0 });
  } catch (err) {
    logger.warn(`[sms] could not read this month's SMS spend — not sending: ${err.message}`);
    return /** @type {const} */ ({ status: "failed", segments: 0 });
  }
};

/**
 * Whether a message may go at all this month — for a caller that reserves its
 * own row (servicesPhone). "capped" or "failed" (cap unreadable), or null.
 * @param {string} purpose
 */
export const smsRefusedByCap = async (purpose) => (await capRefusal(purpose))?.status ?? null;

/**
 * Send one SMS. Never throws — the answer says what happened:
 *   "sent"    the provider accepted it
 *   "logged"  no provider configured; written to the log (development)
 *   "failed"  the provider refused or could not be reached
 *   "capped"  this month's cap is reached; nothing was sent or recorded
 *
 * @param {{ userId: number | null, to: string, body: string, purpose: string }} message
 *   `purpose` is "verification" or a notification category — what the admin's
 *   screen groups by.
 * @returns {Promise<{ status: "sent" | "logged" | "failed" | "capped", segments: number, providerCode?: number | null }>}
 */
export const sendSms = async ({ userId, to, body, purpose }) => {
  const refused = await capRefusal(purpose);
  if (refused) return refused;
  let id = null;
  try {
    id = await reserveSms(pool, { userId, to, purpose });
  } catch (err) {
    // Unrecorded is better than unsent for a message somebody asked for.
    logger.warn(`[sms] could not record a ${purpose} message before sending: ${err.message}`);
  }
  return transmitReserved(id, { to, body });
};

/**
 * The verification codes sent in the last `windowMinutes` — to one number
 * (across every account, which is the point: many accounts cannot flood one
 * phone) or by one account (to whatever numbers it tried) — and how many
 * minutes until the oldest of them leaves the window.
 *
 * Every row counts, a message still 'sending' included.
 *
 * @param {{ to: string } | { userId: number }} who
 * @param {number} windowMinutes
 * @param {{ query: Function }} [db] the pool, or the caller's transaction
 * @returns {Promise<{ count: number, waitMinutes: number }>}
 */
export const recentVerificationSends = async (who, windowMinutes, db = pool) => {
  const [column, value] = "to" in who ? ["phone_hash", phoneHash(who.to)] : ["user_id", who.userId];
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count,
            COALESCE(CEIL(EXTRACT(EPOCH FROM (MIN(created_at) + make_interval(mins => $2::int) - NOW())) / 60), 0)::int AS wait_minutes
       FROM sms_usage
      WHERE ${column} = $1 AND purpose = 'verification'
        AND created_at > NOW() - make_interval(mins => $2::int)`,
    [value, windowMinutes]
  );
  return { count: rows[0]?.count ?? 0, waitMinutes: Math.max(1, rows[0]?.wait_minutes ?? 1) };
};

/** The admin's screen: this month by purpose, the spend and the cap. */
export const monthSmsReport = async () => {
  const [byPurpose, spent] = await Promise.all([
    pool.query(
      `SELECT purpose,
              COUNT(*)::int AS messages,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
              COALESCE(SUM(segments), 0)::int AS segments,
              COALESCE(SUM(cost_usd), 0)::float AS cost_usd
         FROM sms_usage WHERE created_at >= ${MONTH_START_SQL}
        GROUP BY purpose ORDER BY cost_usd DESC, messages DESC`
    ),
    monthSmsSpendUsd(),
  ]);
  return {
    spentUsd: spent,
    capUsd: env.smsMonthlyCapUsd,
    configured: env.smsConfigured,
    byPurpose: byPurpose.rows,
  };
};
