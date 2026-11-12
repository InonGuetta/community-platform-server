// @ts-check
// The token behind the "הסרה מרשימת התפוצה" link in every notification mail
// (PRD NOTIF-6).
//
// Unsubscribing has to work without signing in — it is followed from an inbox,
// often on a phone that has never opened the app — so the link carries its own
// credential: a signed token naming the user and the category of mail. It grants
// exactly one thing, turning that mail off (or all of it), and nothing else.
//
// ── Its own key ─────────────────────────────────────────────────────────────
//
// Signed with a key DERIVED from JWT_SECRET rather than JWT_SECRET itself. The
// two token kinds then cannot stand in for each other: a session cookie is not
// a valid unsubscribe token, and — the direction that matters — a link sitting
// in somebody's mailbox forever is not a session. No new environment variable,
// and rotating JWT_SECRET rotates both.
//
// ── No expiry ───────────────────────────────────────────────────────────────
//
// A mail from last year must still unsubscribe. What the token can do is so
// narrow — and so plainly what its holder wants — that a lifetime costs nothing.
import { createHmac } from "crypto";
import jwt from "jsonwebtoken";
import { env } from "./env.js";

const PURPOSE = "unsubscribe";

// Never derived from an empty secret: a process that has not loaded .env would
// otherwise sign tokens with a key anybody could compute. The server cannot get
// here without JWT_SECRET (lib/checkEnv.js); a script can, and must fail loudly.
const key = () => {
  if (!env.jwtSecret) throw new Error("JWT_SECRET is not set — cannot sign or read unsubscribe tokens");
  return createHmac("sha256", env.jwtSecret).update("notification-unsubscribe").digest("hex");
};

/** @param {number} userId @param {string} category */
export const signUnsubscribeToken = (userId, category) =>
  jwt.sign({ sub: String(userId), cat: category, purpose: PURPOSE }, key());

/**
 * @param {unknown} token
 * @returns {{ userId: number, category: string } | null} null for anything that is not a valid token
 */
export const readUnsubscribeToken = (token) => {
  if (typeof token !== "string" || token.length === 0 || token.length > 1000) return null;
  try {
    const payload = /** @type {any} */ (jwt.verify(token, key()));
    const userId = Number(payload?.sub);
    if (payload?.purpose !== PURPOSE || !Number.isInteger(userId) || typeof payload.cat !== "string") return null;
    return { userId, category: payload.cat };
  } catch {
    return null;
  }
};
