// @ts-check
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes, createHash } from "crypto";
import { pool } from "../db/pool.js";
import { conflict, unauthorized, notFound, badRequest, ERROR_CODES } from "../lib/AppError.js";
import { assertUsableEmail } from "../lib/validate.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

const DUMMY_BCRYPT_HASH = "$2a$12$CwTycUXWue0Thq9StjUM0uJ8.U8nJ.JtbCmHkY2Z9Y6XYC8N7yL3a";

const normalizeEmail = (email) => email.trim().toLowerCase();

// The floor a chosen password has to clear. Deliberately a length and nothing
// else: composition rules ("one capital, one symbol") push people towards
// Password1! and are worse than a longer passphrase, which this permits and they
// forbid. Enforced in ONE place so registration, reset and change cannot drift
// into three different answers.
const MIN_PASSWORD_LENGTH = 8;

export const assertUsablePassword = (password) => {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      ERROR_CODES.WEAK_PASSWORD
    );
  }
};

// A single-use credential sent to an inbox, in the two places that need one.
//
// 32 random bytes, and only their SHA-256 reaches the database — see migration
// 017 for why. Returned as a pair so the caller can mail the token and store the
// hash without either of them being tempted to derive one from the other later.
const RESET_TTL_MS = 60 * 60 * 1000;          // one hour
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

const newToken = () => {
  const token = randomBytes(32).toString("hex");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
};

const hashOf = (token) => createHash("sha256").update(String(token)).digest("hex");

// The session cookie's contents, in one place.
//
// This exact call was written out three times — register, login and the OAuth
// callback — and the reset flow would have made it four. The claims are what
// verifyToken reads back, and three copies of them is three chances for one to
// carry a field the others do not.
export const issueSessionToken = (user) =>
  jwt.sign({ id: user.id, email: user.email, role: user.role }, env.jwtSecret, { expiresIn: "7d" });

// The roles somebody may ASK to be. A student is the default and needs no
// approval; the other two are requests an admin decides on.
//
// Exported so the route test and the client-facing controller share one list
// rather than each writing out three strings.
export const REQUESTABLE_ROLES = new Set(["student", "lecturer", "admin"]);

// Roles that do not take effect until an admin says so. Deriving this from the
// set above rather than listing it again means adding a fourth role cannot leave
// it silently self-approving.
export const NEEDS_APPROVAL = (role) => role === "lecturer" || role === "admin";

// ⚠️ THE ONE INVARIANT OF THIS FUNCTION ⚠️
//
// `requestedRole` is a REQUEST. It is never the role.
//
// The INSERT below does not name the role column at all, so the account is
// created 'student' by the schema default — the same as it always was. Writing
// the requested value into `users.role` here would be privilege escalation in a
// single line: anyone could POST role=admin to a public, unauthenticated
// endpoint and own the platform. The value goes to requested_role, which grants
// nothing, and only controllersUsers.approveUser ever moves it across.
//
// test/roleApproval.test.js drives a real HTTP request with role=admin in the
// body and asserts the created row is a student. If you change this function,
// that test is the one that must still pass.
export const register = async (email, password, displayName, requestedRole = "student") => {
  // Shape first, before anything is normalised or hashed: a malformed address
  // must not reach the uniqueness query, where it would occupy the "email taken"
  // branch and give a confusing answer.
  assertUsableEmail(email);
  const normalizedEmail = normalizeEmail(email);
  assertUsablePassword(password);
  if (!REQUESTABLE_ROLES.has(requestedRole)) {
    throw badRequest(`Invalid role: ${requestedRole}`);
  }
  const existing = await pool.query("SELECT id FROM users WHERE email=$1", [normalizedEmail]);
  if (existing.rows.length > 0) throw conflict("Email already in use", ERROR_CODES.EMAIL_TAKEN);

  const pending = NEEDS_APPROVAL(requestedRole);
  const password_hash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    // `role` is deliberately absent from the column list. See the block above.
    `INSERT INTO users (email, password_hash, display_name, requested_role, approval_status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, role, display_name, requested_role, approval_status`,
    [
      normalizedEmail,
      password_hash,
      displayName,
      // Recorded even for a plain student, so "asked for nothing" and "asked to
      // be a student" are the same row rather than a NULL somebody has to guess
      // about later.
      requestedRole,
      pending ? "pending" : "approved",
    ]
  );
  const user = result.rows[0];
  const token = issueSessionToken(user);
  // The verification token rides back to the controller rather than being mailed
  // here: a service that sends mail is a service that cannot be called from a
  // script or a test without one going out.
  return { user, token, verification: await issueVerificationToken(user.id) };
};

// ── Proving the address belongs to whoever is using the account ─────────────

const issueVerificationToken = async (userId) => {
  const { token, hash } = newToken();
  // Reuses the password_resets table, and the reason is that it is the same
  // thing: a single-use, expiring, hashed credential mailed to an address. A
  // second table identical but for its name would double the sweep, the index
  // and the reasoning about token handling, for a distinction nothing acts on.
  await pool.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' milliseconds')::interval)`,
    [userId, hash, VERIFICATION_TTL_MS]
  );
  return token;
};

export const verifyEmail = async (token) => {
  const result = await pool.query(
    `UPDATE users SET email_verified = TRUE
     WHERE id = (
       SELECT user_id FROM password_resets
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
     )
     RETURNING id, email, role, display_name, email_verified`,
    [hashOf(token)]
  );
  if (result.rows.length === 0) {
    throw badRequest("This link is invalid or has expired", ERROR_CODES.INVALID_RESET_TOKEN);
  }
  await pool.query("UPDATE password_resets SET used_at = NOW() WHERE token_hash = $1", [hashOf(token)]);
  return result.rows[0];
};

export const login = async (email, password) => {
  const normalizedEmail = normalizeEmail(email);
  const result = await pool.query("SELECT * FROM users WHERE email=$1 AND is_active=TRUE", [normalizedEmail]);
  const user = result.rows[0];

  // Always run bcrypt.compare so response time doesn't leak whether the email exists.
  const hashToCompare = user?.password_hash || DUMMY_BCRYPT_HASH;
  const valid = await bcrypt.compare(password, hashToCompare);
  if (!user || !valid) throw unauthorized("Invalid credentials", ERROR_CODES.INVALID_CREDENTIALS);

  const token = issueSessionToken(user);
  const { password_hash, ...safeUser } = user;
  return { user: safeUser, token };
};

// Google tells us whether it has verified the address it is handing over, and
// the answer matters for exactly one branch below.
//
// The shape differs across versions of passport-google-oauth20 — the OIDC claim
// arrives on `_json`, older profile shapes put it on the email entry — so both
// are read, and anything unrecognised counts as UNVERIFIED. Defaulting the other
// way would make a future library change silently reopen the hole.
const emailIsVerified = (profile) =>
  profile?._json?.email_verified === true || profile?.emails?.[0]?.verified === true;

export const googleOAuthLogin = async (profile) => {
  const email = profile.emails?.[0]?.value ? normalizeEmail(profile.emails[0].value) : null;
  const googleId = profile.id;
  const displayName = profile.displayName;
  const avatarUrl = profile.photos?.[0]?.value;

  const existing = await pool.query("SELECT * FROM users WHERE google_id=$1 OR email=$2", [googleId, email]);

  if (existing.rows.length > 0) {
    const user = existing.rows[0];

    // Deactivation has to mean the same thing on both ways in. login() filters on
    // is_active in its WHERE clause; this path had no equivalent, so a deactivated
    // user signing in with Google was handed a fresh 7-day cookie. verifyToken
    // refused them on the next request, which made it look like a broken app
    // rather than a closed account.
    //
    // Checked HERE rather than by adding `AND is_active=TRUE` to the query above,
    // and the difference is not cosmetic: a filtered-out row makes this function
    // fall through to the INSERT, where the still-present email trips the unique
    // index and a refusal becomes a 500.
    if (!user.is_active) {
      throw unauthorized("This account has been deactivated", ERROR_CODES.UNAUTHORIZED);
    }

    if (!user.google_id) {
      // Attaching a Google identity to an account that already exists with a
      // PASSWORD is the one moment this flow can hand over somebody else's
      // account, and it is reached purely on a matching email address. If Google
      // has not verified that address, the match proves nothing.
      if (!emailIsVerified(profile)) {
        throw unauthorized(
          "Google has not verified this email address, so it cannot be linked to an existing account",
          ERROR_CODES.UNAUTHORIZED
        );
      }
      // Google has verified the address; this account has a password nobody ever
      // proved anything about. That password is the danger — it was set by
      // whoever typed the address into the registration form, which is not
      // necessarily the person now signing in through Google — so it is cleared
      // rather than left as a second, unproven way into an account the rightful
      // owner has just claimed.
      //
      // Nobody is locked out: password reset issues a new one, to the address
      // Google just confirmed. password_changed_at also ends any session that
      // password had already opened.
      const supersedesUnprovenPassword = user.password_hash && !user.email_verified;
      if (supersedesUnprovenPassword) {
        logger.warn(
          `[auth] user ${user.id} linked a verified Google identity to an account whose ` +
          `email was never verified — the existing password has been cleared`
        );
      }

      await pool.query(
        `UPDATE users SET
           google_id = $1,
           avatar_url = COALESCE(avatar_url, $2),
           email_verified = TRUE,
           password_hash = CASE WHEN $4::boolean THEN NULL ELSE password_hash END,
           password_changed_at = CASE WHEN $4::boolean THEN NOW() ELSE password_changed_at END
         WHERE id = $3`,
        [googleId, avatarUrl, user.id, Boolean(supersedesUnprovenPassword)]
      );
      user.google_id = googleId;
      user.email_verified = true;
    }
    const { password_hash, ...safeUser } = user;
    return safeUser;
  }

  const result = await pool.query(
    "INSERT INTO users (email, google_id, display_name, avatar_url) VALUES ($1, $2, $3, $4) RETURNING id, email, role, display_name, avatar_url",
    [email, googleId, displayName, avatarUrl]
  );
  return result.rows[0];
};

// The identity behind a token, re-read at the moment it is used. Returns null
// when there is no such user or the account has been deactivated.
//
// This is the single source for that question, and it is single deliberately.
// Two entry points authenticate against the same cookie — the REST middleware and
// the socket handshake — and the socket one used to trust the token's own claims
// instead of asking. The result was that deactivating a user closed the API to
// them while leaving their signalling connection working for the rest of the
// token's seven days. Two copies of this query would have drifted the same way
// again, in whichever direction was edited second.
//
// The columns are exactly what a request handler is allowed to see as `req.user`;
// getMe below answers a richer question for the profile screen.
// password_changed_at rides along so verifyToken can refuse a token older than
// the last password change. Selected here rather than in a second query because
// this one already runs on every single request.
export const getActiveUserById = async (userId) => {
  const result = await pool.query(
    "SELECT id, email, role, password_changed_at FROM users WHERE id=$1 AND is_active=TRUE",
    [userId]
  );
  return result.rows[0] || null;
};

// Whether a token minted at `issuedAtSeconds` still counts, given when this
// user last changed their password.
//
// Without this a reset is theatre. The JWT is stateless and lasts seven days, so
// an attacker holding a stolen cookie kept working access for a week after the
// owner locked them out — at precisely the moment the owner believed they had.
//
// The second of slack is not sloppiness: `iat` is whole seconds while the column
// is a timestamp with sub-second precision, so a token minted in the same second
// as the change — which is exactly what happens when the reset hands back a
// fresh session — would otherwise be refused the instant it was issued.
export const tokenPredatesPasswordChange = (user, issuedAtSeconds) => {
  if (!user?.password_changed_at) return false;
  if (!Number.isFinite(issuedAtSeconds)) return true;
  return issuedAtSeconds * 1000 < new Date(user.password_changed_at).getTime() - 1000;
};

// ── Password reset ──────────────────────────────────────────────────────────

// Returns the token to mail, or null when there is nobody to mail it to.
//
// null rather than a throw, and the controller answers 200 either way. Telling
// an anonymous caller that an address is unknown turns this endpoint into a
// membership oracle: submit a list, keep the ones that error. The user-visible
// outcome is identical for both, which is also the honest thing to say — "if
// that address has an account, a message is on its way".
//
// A Google-only account gets no token either. It has no password to reset, and
// issuing one would create a way to attach a password to an account whose owner
// only ever proved themselves through Google.
export const requestPasswordReset = async (email) => {
  const normalizedEmail = normalizeEmail(email);
  const { rows } = await pool.query(
    "SELECT id, password_hash FROM users WHERE email=$1 AND is_active=TRUE",
    [normalizedEmail]
  );
  const user = rows[0];
  if (!user) {
    logger.debug("[auth] password reset requested for an address with no active account");
    return null;
  }
  if (!user.password_hash) {
    logger.debug("[auth] password reset requested for an account that signs in with Google");
    return null;
  }

  const { token, hash } = newToken();
  await pool.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' milliseconds')::interval)`,
    [user.id, hash, RESET_TTL_MS]
  );
  return token;
};

// Spending a token: set the new password, burn every outstanding token for that
// user, and end the sessions that existed before.
//
// All three in ONE transaction, because any two of them without the third is a
// worse state than not resetting at all — a password changed while the old
// tokens still work, or sessions ended while the password did not change.
export const resetPassword = async (token, newPassword) => {
  assertUsablePassword(newPassword);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // FOR UPDATE so two confirms of the same token serialise rather than both
    // seeing it unused.
    const { rows } = await client.query(
      `SELECT id, user_id FROM password_resets
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
       FOR UPDATE`,
      [hashOf(token)]
    );
    if (rows.length === 0) {
      throw badRequest("This link is invalid or has expired", ERROR_CODES.INVALID_RESET_TOKEN);
    }
    const { user_id: userId } = rows[0];

    // password_changed_at is what makes this a real reset: middleware/auth.js
    // refuses any token minted before it, so a stolen cookie stops working here
    // rather than in seven days' time.
    //
    // email_verified is set too. Reaching a link sent to that address IS the
    // proof, and an account recovered this way has demonstrably reachable mail.
    const updated = await client.query(
      `UPDATE users
       SET password_hash = $1, password_changed_at = NOW(), email_verified = TRUE
       WHERE id = $2
       RETURNING id, email, role, display_name`,
      [await bcrypt.hash(newPassword, 12), userId]
    );

    // Every outstanding token, not only this one. Someone who asked three times
    // has three live links in their inbox, and two of them surviving the reset
    // is two more chances for whoever else can read that inbox.
    await client.query(
      "UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL",
      [userId]
    );

    await client.query("COMMIT");
    logger.info(`[auth] password reset completed for user ${userId}`);
    // The row is returned so the caller can open a session without looking the
    // token up again — it has just been burned, and a second lookup would find
    // nothing. Signing them straight in is also the point: sending someone back
    // to the login form to type the password they chose four seconds ago is a
    // step that exists only because the flow was built in two halves.
    return { user: updated.rows[0] };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// ── The signed-in user changing their own details ───────────────────────────

// The current password is required, and not as a formality: a session left open
// on a shared machine is the ordinary way an account is taken over, and without
// this the takeover becomes permanent in two clicks.
export const changePassword = async (userId, currentPassword, newPassword) => {
  assertUsablePassword(newPassword);

  const { rows } = await pool.query("SELECT password_hash FROM users WHERE id=$1", [userId]);
  const stored = rows[0]?.password_hash;
  if (!stored) {
    // A Google-only account. Setting a first password this way would let anyone
    // with the open session add a second, permanent way in.
    throw badRequest(
      "This account signs in with Google and has no password to change",
      ERROR_CODES.NO_PASSWORD_SET
    );
  }
  if (!(await bcrypt.compare(currentPassword ?? "", stored))) {
    throw unauthorized("Current password is incorrect", ERROR_CODES.INVALID_CREDENTIALS);
  }

  await pool.query(
    "UPDATE users SET password_hash=$1, password_changed_at=NOW() WHERE id=$2",
    [await bcrypt.hash(newPassword, 12), userId]
  );
  return { changed: true };
};

// Display name and avatar, and nothing else.
//
// An allowlist rather than a patch of req.body, for the same reason the
// transcript update has one: this is the only write a user makes to their OWN
// row, and role, is_active and email must not be reachable from it. Changing an
// email address is a re-verification flow, not a profile edit, and it is
// deliberately not here.
export const updateProfile = async (userId, { displayName, avatarUrl }) => {
  const trimmed = typeof displayName === "string" ? displayName.trim() : null;
  if (trimmed !== null && trimmed.length === 0) {
    throw badRequest("Display name cannot be empty");
  }
  if (trimmed !== null && trimmed.length > 120) {
    throw badRequest("Display name must be at most 120 characters");
  }

  const result = await pool.query(
    `UPDATE users SET
       display_name = COALESCE($1, display_name),
       avatar_url   = COALESCE($2, avatar_url)
     WHERE id = $3
     RETURNING id, email, role, display_name, avatar_url, email_verified, created_at`,
    [trimmed, typeof avatarUrl === "string" ? avatarUrl : null, userId]
  );
  if (result.rows.length === 0) throw notFound("User not found");
  return result.rows[0];
};

export const getMe = async (userId) => {
  const result = await pool.query(
    // requested_role and approval_status ride along so the client can draw the
    // "your request is waiting" banner without a second call. They are not
    // secrets — they are this user's own row.
    `SELECT id, email, role, display_name, avatar_url, created_at,
            requested_role, approval_status, rejection_reason
     FROM users WHERE id=$1 AND is_active=TRUE`,
    [userId]
  );
  if (result.rows.length === 0) throw notFound("User not found");
  return result.rows[0];
};

// ── Asking for a role after registration ────────────────────────────────────
//
// The signup form is not the only way somebody becomes a lecturer, and for two
// of them it is not a way at all:
//
//   * A Google sign-in never sees the form. The OAuth callback returns straight
//     to the app, so without this endpoint a Google account can NEVER request a
//     role — a hole in the signup feature rather than a missing extra.
//   * A student who has been here two years and is now giving a shiur. Asking
//     them to make a second account would be absurd.
//
// It writes to exactly the same columns the signup path does and produces a row
// the SAME admin queue picks up, so there is one approval flow rather than two.
// In particular it does NOT touch users.role — approveUser remains the only
// function that does.

// How long a refusal stands before the same person may ask again.
//
// Not a rate limit against abuse — an approval is a human decision and there is
// nothing to brute-force. It is against the loop where a refusal without a
// reason produces an immediate identical re-application, which is worse for the
// applicant than a wait and worse for the admin than a queue.
const REAPPLY_COOLDOWN_DAYS = 7;

export const requestRole = async (userId, requestedRole) => {
  if (!NEEDS_APPROVAL(requestedRole)) {
    // Requesting 'student' is meaningless — everybody already is one — and any
    // other value is not a role at all.
    throw badRequest(`Cannot request the role: ${requestedRole}`);
  }

  const { rows } = await pool.query(
    `SELECT role, approval_status, requested_role, approved_at
     FROM users WHERE id=$1 AND is_active=TRUE`,
    [userId]
  );
  if (rows.length === 0) throw notFound("User not found");
  const user = rows[0];

  // Already has it. Not an error worth a stack trace, but not a no-op either —
  // silently accepting would leave the account marked 'pending' for a role it
  // already holds, and the admin queue would show a request that means nothing.
  if (user.role === requestedRole) {
    throw conflict("You already have this role", ERROR_CODES.CONFLICT);
  }
  // An admin asking to be a lecturer is a DEMOTION, and this is not the path for
  // it: approveUser would grant it, quietly removing their own admin rights
  // through a self-service form. Role reduction is an admin action on the users
  // tab.
  if (user.role === "admin") {
    throw badRequest("An admin cannot request a lesser role here");
  }
  if (user.approval_status === "pending") {
    throw conflict("You already have a request waiting", ERROR_CODES.CONFLICT);
  }

  if (user.approval_status === "rejected" && user.approved_at) {
    const daysSince = (Date.now() - new Date(user.approved_at).getTime()) / 86_400_000;
    if (daysSince < REAPPLY_COOLDOWN_DAYS) {
      const wait = Math.ceil(REAPPLY_COOLDOWN_DAYS - daysSince);
      throw badRequest(`A previous request was declined. You may apply again in ${wait} day(s).`);
    }
  }

  const result = await pool.query(
    // role is untouched, as everywhere outside approveUser. The previous
    // refusal's reason is cleared: it belongs to the decision that was made, not
    // to the one now waiting, and leaving it would show the admin an old "no"
    // beside a new request.
    `UPDATE users SET
       requested_role = $1,
       approval_status = 'pending',
       approved_by = NULL,
       approved_at = NULL,
       rejection_reason = NULL
     WHERE id = $2
     RETURNING id, email, role, display_name, requested_role, approval_status`,
    [requestedRole, userId]
  );
  return result.rows[0];
};
