// @ts-check
// A user's own mobile number: added, proved with a code by SMS, changed and
// removed (migration 054, PRD AUTH-13).
//
// ── Two places, one meaning ─────────────────────────────────────────────────
//
// users.phone_e164 + phone_verified_at hold the number that IS verified, and
// are only ever written together, by `verifyPhoneCode`. A number still waiting
// for its code lives in phone_verifications — one row per user — so changing a
// number leaves the old one working until the new one is proved, and nothing
// that sends an SMS can reach a number nobody has proved they hold.
//
// ── The code ────────────────────────────────────────────────────────────────
//
// Six random digits, valid for ten minutes and five attempts. Stored as an
// HMAC under a key derived from JWT_SECRET, over the user, the number and the
// code — a leaked table alone cannot be brute-forced over the million codes,
// and a code proves only that number for that account.
//
// ── Limits ──────────────────────────────────────────────────────────────────
//
// Every code is an SMS somebody pays for and a phone somebody receives, so:
// one a minute, and three an hour both per account and per NUMBER (across
// accounts — sms_usage keeps a hash of each number for exactly this). The
// router's per-user limit only stops a client looping.
//
// ── One number, one account ─────────────────────────────────────────────────
//
// Proving a number that another account had verified MOVES it here: the other
// account loses it (and its SMS choices), rather than this one being told
// "taken" — which would tell anybody who typed a number whether it belongs to
// a member. Whoever proves they hold the phone now is its owner.
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/transaction.js";
import { env } from "../lib/env.js";
import { AppError, notFound, badRequest, ERROR_CODES } from "../lib/AppError.js";
import { forLocale } from "../lib/i18n.js";
import { reserveSms, transmitReserved, smsRefusedByCap, recentVerificationSends } from "./servicesSms.js";
import { phoneHash } from "../lib/phone.js";

export const CODE_TTL_MINUTES = 10;
export const MAX_ATTEMPTS = 5;
export const SENDS_PER_HOUR = 3;
export const RESEND_AFTER_SECONDS = 60;

const key = () => {
  if (!env.jwtSecret) throw new Error("JWT_SECRET is not set — cannot hash phone codes");
  return createHmac("sha256", env.jwtSecret).update("phone-verification").digest();
};

/** @param {number} userId @param {string} e164 @param {string} code */
export const hashCode = (userId, e164, code) =>
  createHmac("sha256", key()).update(`${userId}:${e164}:${code}`).digest("hex");

/** @param {string} a @param {string} b — both hex of one length, or not equal */
const sameHash = (a, b) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

/**
 * The phone part of one's own account, as the account page reads it — in the
 * user object's own snake_case, since the client merges it into that object.
 * @param {{ phone_e164: string | null, phone_verified_at: Date | string | null, phone_pending?: string | null, phone_pending_expires_at?: Date | string | null }} row
 */
export const phoneStateOf = (row) => ({
  phone: row.phone_verified_at ? row.phone_e164 : null,
  phone_verified_at: row.phone_verified_at ?? null,
  phone_pending: row.phone_pending ?? null,
  phone_pending_expires_at: row.phone_pending_expires_at ?? null,
});

// The columns phoneStateOf reads, for a SELECT FROM users u.
export const PHONE_STATE_SQL = `u.phone_e164, u.phone_verified_at,
  pv.phone_e164 AS phone_pending, pv.expires_at AS phone_pending_expires_at`;
// Joins the waiting number — only while its code is still good.
export const PHONE_PENDING_JOIN = "LEFT JOIN phone_verifications pv ON pv.user_id = u.id AND pv.expires_at > NOW()";

/** @param {number} userId */
export const getPhoneState = async (userId) => {
  const { rows } = await pool.query(
    `SELECT ${PHONE_STATE_SQL} FROM users u ${PHONE_PENDING_JOIN} WHERE u.id = $1 AND u.is_active = TRUE`,
    [userId]
  );
  if (rows.length === 0) throw notFound("User not found");
  return phoneStateOf(rows[0]);
};

/** @param {number} minutes */
const sendLimit = (minutes) =>
  new AppError("Too many codes sent", 429, ERROR_CODES.PHONE_SEND_LIMIT, { minutes });

/**
 * The SMS the code goes in, in the account's language — one segment in each
 * (70 characters of Hebrew). No WebOTP line ("@host #code"): it would make the
 * Hebrew message two segments, twice the price, and a phone already offers a
 * code from an SMS to a field marked autocomplete="one-time-code".
 * @param {string | null} locale @param {string} code
 */
export const codeMessage = (locale, code) => forLocale(locale).t("sms.code", { code });

/**
 * Send a code to a number the user typed (already E.164, requirePhone).
 * Answers with the account's phone state; the number waits for its code.
 *
 * @param {number} userId
 * @param {string} e164
 */
export const startPhoneVerification = async (userId, e164) => {
  const capped = await smsRefusedByCap("verification");
  if (capped === "capped") throw budgetReached();
  if (capped) throw smsFailed();

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  // The limits are checked and the send reserved in ONE transaction, holding a
  // lock on the number and then on the account — always in that order, so two
  // of these can never wait on each other. A request a moment behind another
  // waits for it, then counts its reserved row.
  const plan = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phone-number:${phoneHash(e164)}`]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phone-user:${userId}`]);
    const { rows } = await client.query(
      `SELECT u.locale, u.phone_e164, u.phone_verified_at, pv.created_at AS last_sent_at
         FROM users u LEFT JOIN phone_verifications pv ON pv.user_id = u.id
        WHERE u.id = $1 AND u.is_active = TRUE`,
      [userId]
    );
    if (rows.length === 0) throw notFound("User not found");
    const user = rows[0];
    // Already this account's verified number: nothing to prove, nothing to send.
    if (user.phone_verified_at && user.phone_e164 === e164) {
      await client.query("DELETE FROM phone_verifications WHERE user_id = $1", [userId]);
      return null;
    }

    if (user.last_sent_at && Date.now() - new Date(user.last_sent_at).getTime() < RESEND_AFTER_SECONDS * 1000) {
      throw sendLimit(1);
    }
    for (const who of [{ userId }, { to: e164 }]) {
      const sends = await recentVerificationSends(who, 60, client);
      if (sends.count >= SENDS_PER_HOUR) throw sendLimit(sends.waitMinutes);
    }

    await client.query(
      `INSERT INTO phone_verifications (user_id, phone_e164, code_hash, attempts, expires_at, created_at)
       VALUES ($1, $2, $3, 0, NOW() + make_interval(mins => $4::int), NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET phone_e164 = EXCLUDED.phone_e164, code_hash = EXCLUDED.code_hash, attempts = 0,
             expires_at = EXCLUDED.expires_at, created_at = EXCLUDED.created_at`,
      [userId, e164, hashCode(userId, e164, code), CODE_TTL_MINUTES]
    );
    const smsId = await reserveSms(client, { userId, to: e164, purpose: "verification" });
    return { smsId, locale: user.locale };
  });
  if (plan === null) return getPhoneState(userId);

  const sent = await transmitReserved(plan.smsId, { to: e164, body: codeMessage(plan.locale, code) });
  if (sent.status === "failed") {
    // No code reached the phone, so none may be typed back. The reserved row
    // stays, counted: a provider that keeps failing is not a way around the
    // hourly limit.
    await pool.query("DELETE FROM phone_verifications WHERE user_id = $1 AND phone_e164 = $2", [userId, e164]);
    throw smsFailed();
  }
  return getPhoneState(userId);
};

const budgetReached = () =>
  new AppError("This month's SMS budget has been reached", 429, ERROR_CODES.SMS_BUDGET_EXCEEDED);
const smsFailed = () => new AppError("The SMS could not be sent", 503, ERROR_CODES.SMS_FAILED);

/**
 * Check the code typed back. Right: the number becomes this account's verified
 * number (moved from any other account that had it). Wrong: one attempt spent.
 *
 * The attempt is counted in a transaction that COMMITS before the refusal is
 * thrown — a throw inside it would roll the count back and make guessing free.
 *
 * @param {number} userId
 * @param {string} code from phoneCodeOf
 * @returns {Promise<{ state: ReturnType<typeof phoneStateOf>, movedFrom: number | null }>}
 */
export const verifyPhoneCode = async (userId, code) => {
  const outcome = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT phone_e164, code_hash, attempts, expires_at <= NOW() AS expired
         FROM phone_verifications WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    const pending = rows[0];
    if (!pending) return { refusal: "expired" };
    if (pending.expired) {
      await client.query("DELETE FROM phone_verifications WHERE user_id = $1", [userId]);
      return { refusal: "expired" };
    }
    if (pending.attempts >= MAX_ATTEMPTS) return { refusal: "limit" };

    const right = /^\d{6}$/.test(code) && sameHash(hashCode(userId, pending.phone_e164, code), pending.code_hash);
    if (!right) {
      const attempts = pending.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await client.query("DELETE FROM phone_verifications WHERE user_id = $1", [userId]);
        return { refusal: "limit" };
      }
      await client.query("UPDATE phone_verifications SET attempts = $2 WHERE user_id = $1", [userId, attempts]);
      return { refusal: "wrong", attemptsLeft: MAX_ATTEMPTS - attempts };
    }

    // Right. Whoever had this number verified loses it, with its SMS choices,
    // before this account takes it — the unique index allows one holder.
    const moved = await client.query(
      `UPDATE users SET phone_e164 = NULL, phone_verified_at = NULL
        WHERE phone_e164 = $1 AND phone_verified_at IS NOT NULL AND id <> $2
       RETURNING id`,
      [pending.phone_e164, userId]
    );
    const movedFrom = moved.rows[0]?.id ?? null;
    if (movedFrom !== null) {
      await client.query("DELETE FROM notification_sms_optins WHERE user_id = $1", [movedFrom]);
    }
    await client.query(
      "UPDATE users SET phone_e164 = $1, phone_verified_at = NOW() WHERE id = $2",
      [pending.phone_e164, userId]
    );
    await client.query("DELETE FROM phone_verifications WHERE user_id = $1", [userId]);
    return { refusal: null, movedFrom };
  });

  if (outcome.refusal === "expired") {
    throw badRequest("The code has expired", ERROR_CODES.PHONE_CODE_EXPIRED);
  }
  if (outcome.refusal === "limit") {
    throw new AppError("Too many attempts", 429, ERROR_CODES.PHONE_CODE_LIMIT);
  }
  if (outcome.refusal === "wrong") {
    throw badRequest("Wrong code", ERROR_CODES.PHONE_CODE_INVALID, { attemptsLeft: outcome.attemptsLeft ?? 0 });
  }
  return { state: await getPhoneState(userId), movedFrom: outcome.movedFrom ?? null };
};

/**
 * Remove the number — verified, waiting, or both — and with it every SMS
 * choice: a number added later starts with SMS off, as a new one does.
 * @param {number} userId
 */
export const removePhone = async (userId) => {
  await withTransaction(async (client) => {
    await client.query("UPDATE users SET phone_e164 = NULL, phone_verified_at = NULL WHERE id = $1", [userId]);
    await client.query("DELETE FROM phone_verifications WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM notification_sms_optins WHERE user_id = $1", [userId]);
  });
  return getPhoneState(userId);
};
