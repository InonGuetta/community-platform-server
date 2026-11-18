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

/**
 * Record one message. Never throws: the message has already gone (or failed),
 * and a failure to write it down must not fail the work that sent it.
 * @param {{ userId: number | null, purpose: string, to: string, segments: number, status: string }} row
 */
const recordSms = async ({ userId, purpose, to, segments, status }) => {
  // Only a message the provider accepted costs anything; a logged one is free.
  const cost = status === "sent" ? segments * env.smsPricePerSegmentUsd : 0;
  try {
    await pool.query(
      `INSERT INTO sms_usage (user_id, purpose, phone_hash, segments, cost_usd, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, purpose.slice(0, 32), phoneHash(to), segments, cost, status]
    );
  } catch (err) {
    logger.warn(`[sms] could not record a ${purpose} message: ${err.message}`);
  }
};

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
  try {
    if (await smsBudgetReached()) {
      logger.warn(`[sms] monthly cap reached — a ${purpose} message was not sent`);
      return { status: "capped", segments: 0 };
    }
  } catch (err) {
    // The cap could not be read: fail closed, as a cap must.
    logger.warn(`[sms] could not read this month's SMS spend — not sending: ${err.message}`);
    return { status: "failed", segments: 0 };
  }
  const result = await transmitSms({ to, body });
  await recordSms({ userId, purpose, to, segments: result.segments, status: result.status });
  return result;
};

/**
 * How many codes this number was sent since `sinceMinutes` ago — across every
 * account, which is the point: one number cannot be flooded by many accounts.
 * @param {string} to E.164
 * @param {number} sinceMinutes
 */
export const smsCountToNumber = async (to, sinceMinutes) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM sms_usage
      WHERE phone_hash = $1 AND purpose = 'verification'
        AND created_at > NOW() - make_interval(mins => $2::int)`,
    [phoneHash(to), sinceMinutes]
  );
  return rows[0]?.n ?? 0;
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
