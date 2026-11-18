// @ts-check
// Sending an SMS, and behaving sensibly on the many machines that cannot.
//
// The second outbound channel, built the way the first was (lib/mailer.js):
// `smsConfigured()` asks whether the provider's values were SUPPLIED, and
// without them a message is written to the log instead of sent — so a
// development machine can follow a verification code by hand, and no test run
// ever reaches a phone.
//
// One provider is wired in, Twilio, through its REST API with fetch: one POST
// does not justify an SDK. Another provider is a second branch in
// `transmitSms`, and nothing above this module changes.
//
// This module only transmits. Whether a message MAY go — the monthly cap — and
// recording what it cost are services/servicesSms.js, because they read and
// write the database.
//
// The number is personal data: it is never logged whole (maskPhone). The body
// is logged only in log mode, where printing it is the point.
import { logger } from "./logger.js";
import { env } from "./env.js";
import { maskPhone } from "./phone.js";

export const smsConfigured = () => env.smsConfigured;

// ── Segments ────────────────────────────────────────────────────────────────
//
// A provider bills per SEGMENT, not per message. A message in the GSM-7
// alphabet (plain Latin text) fits 160 characters in one segment, 153 in each
// of several; anything else — Hebrew, Yiddish, an accented letter outside the
// alphabet, an emoji — is sent as UCS-2, 70 in one, 67 in each of several.
// Spanish and French mostly stay in GSM-7 (é, è, ñ, ü are in it), but one
// letter outside it — á, í, ó, ú, ç, ê — sends the whole message as UCS-2.

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
// Each of these takes two septets (an escape and the character).
const GSM_EXTENDED = "^{}\\[~]|€\f";
const GSM_BASIC_SET = new Set(GSM_BASIC);
const GSM_EXTENDED_SET = new Set(GSM_EXTENDED);

/**
 * How a provider will count this text.
 * @param {string} text
 * @returns {{ encoding: "GSM-7" | "UCS-2", units: number, segments: number }}
 */
export const segmentsOf = (text) => {
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM_BASIC_SET.has(ch)) septets += 1;
    else if (GSM_EXTENDED_SET.has(ch)) septets += 2;
    else { gsm = false; break; }
  }
  if (gsm) {
    return { encoding: "GSM-7", units: septets, segments: septets <= 160 ? 1 : Math.ceil(septets / 153) };
  }
  // UTF-16 code units: an emoji outside the basic plane takes two.
  const units = text.length;
  return { encoding: "UCS-2", units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
};

// ── Sending ─────────────────────────────────────────────────────────────────

const TWILIO_TIMEOUT_MS = 10_000;

/**
 * Twilio's Messages resource. Resolves with the message's id, or throws with
 * Twilio's own message (which never echoes the number back whole).
 * @param {string} to E.164
 * @param {string} body
 */
const sendViaTwilio = async (to, body) => {
  const sid = env.twilioAccountSid;
  const sender = env.smsSender || "";
  const form = new URLSearchParams({ To: to, Body: body });
  // A Messaging Service picks its own number; a plain sender is the From.
  if (sender.startsWith("MG")) form.set("MessagingServiceSid", sender);
  else form.set("From", sender);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid || "")}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${env.twilioAuthToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
    signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
  });
  /** @type {{ sid?: unknown, code?: number, message?: string }} */
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Twilio ${res.status}${data?.code ? ` (${data.code})` : ""}: ${data?.message || "request failed"}`);
    // 21610: the number replied STOP to this sender — the provider will refuse
    // every message until it replies START. The caller turns SMS off for it.
    /** @type {any} */ (err).providerCode = data?.code ?? null;
    throw err;
  }
  return { providerId: typeof data?.sid === "string" ? data.sid : null };
};

/**
 * Send one SMS — or, with no provider configured, log it. Never throws: a
 * failure is an answer, `status: "failed"`, for the caller to word or ignore.
 *
 * @param {{ to: string, body: string }} message `to` in E.164
 * @returns {Promise<{ status: "sent" | "logged" | "failed", segments: number, providerId?: string | null, providerCode?: number | null }>}
 */
export const transmitSms = async ({ to, body }) => {
  const { segments } = segmentsOf(body);
  if (!smsConfigured()) {
    logger.info(`[sms] not configured — would have sent to ${maskPhone(to)} (${segments} segment(s)):\n${body}`);
    return { status: "logged", segments };
  }
  try {
    const { providerId } = await sendViaTwilio(to, body);
    logger.info(`[sms] sent to ${maskPhone(to)} (${segments} segment(s))`);
    return { status: "sent", segments, providerId };
  } catch (err) {
    logger.error(`[sms] could not send to ${maskPhone(to)}: ${err.message}`);
    return { status: "failed", segments, providerCode: /** @type {any} */ (err).providerCode ?? null };
  }
};
