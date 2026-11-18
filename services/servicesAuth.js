// @ts-check
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes, createHash } from "crypto";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/transaction.js";
import { conflict, unauthorized, notFound, badRequest, ERROR_CODES } from "../lib/AppError.js";
import { assertUsableEmail, normalizeEmail } from "../lib/validate.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { isAdmin } from "../lib/permissions.js";
import { phoneStateOf, PHONE_STATE_SQL, PHONE_PENDING_JOIN } from "./servicesPhone.js";

const DUMMY_BCRYPT_HASH = "$2a$12$CwTycUXWue0Thq9StjUM0uJ8.U8nJ.JtbCmHkY2Z9Y6XYC8N7yL3a";

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

// Matches display_name VARCHAR(100) in 001. The profile form used to allow 120,
// so 101–120 characters passed the check and failed at the driver as a 500.
export const DISPLAY_NAME_MAX = 100;

// A display name from a request body: trimmed, length-checked, and null when the
// caller did not send one (which COALESCE reads as "leave it alone"). `required`
// is for the profile edit, where sending an EMPTY name is a mistake worth saying;
// at registration the name is optional and blank simply means none.
export const cleanDisplayName = (value, { required }) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw badRequest("Display name must be text");
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (required) throw badRequest("Display name cannot be empty");
    return null;
  }
  if (trimmed.length > DISPLAY_NAME_MAX) {
    throw badRequest(`Display name must be at most ${DISPLAY_NAME_MAX} characters`);
  }
  return trimmed;
};

// An avatar is shown to OTHER users as an <img src>, so whatever is stored here
// is a URL their browsers fetch. Any scheme and any length used to be accepted —
// enough to point it at a tracking pixel that logs the IP of everyone who sees
// the avatar, or a data: URL megabytes long. https only, and bounded. Google's
// own avatars (the only source today) are https.
const AVATAR_URL_MAX = 2048;
export const cleanAvatarUrl = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > AVATAR_URL_MAX) {
    throw badRequest("Avatar must be an https URL");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw badRequest("Avatar must be an https URL");
  }
  if (parsed.protocol !== "https:") throw badRequest("Avatar must be an https URL");
  return parsed.href;
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
// `locale` is the interface language the visitor was already using (already
// checked by optionalLocale), so a new account starts in it rather than in
// Hebrew; absent, the column's default applies.
export const register = async (email, password, displayName, requestedRole = "student", locale = null) => {
  // Shape first, before anything is normalised or hashed: a malformed address
  // must not reach the uniqueness query, where it would occupy the "email taken"
  // branch and give a confusing answer.
  assertUsableEmail(email);
  const normalizedEmail = normalizeEmail(email);
  assertUsablePassword(password);
  if (!REQUESTABLE_ROLES.has(requestedRole)) {
    throw badRequest(`Invalid role: ${requestedRole}`);
  }
  const cleanName = cleanDisplayName(displayName, { required: false });
  const existing = await pool.query("SELECT id FROM users WHERE email=$1", [normalizedEmail]);
  if (existing.rows.length > 0) throw conflict("Email already in use", ERROR_CODES.EMAIL_TAKEN);

  const pending = NEEDS_APPROVAL(requestedRole);
  const password_hash = await bcrypt.hash(password, 12);
  let result;
  try {
    result = await pool.query(
      // `role` is deliberately absent from the column list. See the block above.
      `INSERT INTO users (email, password_hash, display_name, requested_role, approval_status, locale)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'he'))
       RETURNING id, email, role, display_name, requested_role, approval_status, locale`,
      [
        normalizedEmail,
        password_hash,
        cleanName,
        // Recorded even for a plain student, so "asked for nothing" and "asked to
        // be a student" are the same row rather than a NULL somebody has to guess
        // about later.
        requestedRole,
        pending ? "pending" : "approved",
        locale,
      ]
    );
  } catch (err) {
    // The SELECT above is a courtesy, not the guard: two registrations of the
    // same address both pass it, and the unique index is what refuses the
    // second. Same translation servicesUsers.updateUserRow makes.
    if (err?.code === "23505") throw conflict("Email already in use", ERROR_CODES.EMAIL_TAKEN);
    throw err;
  }
  const user = result.rows[0];
  const token = issueSessionToken(user);
  // The verification token rides back to the controller rather than being mailed
  // here: a service that sends mail is a service that cannot be called from a
  // script or a test without one going out.
  return { user, token, verification: await issueVerificationToken(user.id) };
};

// ── Proving the address belongs to whoever is using the account ─────────────

// Reuses the password_resets table: it is the same kind of thing — a
// single-use, expiring, hashed credential mailed to an address. What makes the
// sharing safe is `purpose` (migration 031). Without it each lookup accepted the
// other flow's token, and a 24-hour verification link was also a working
// password reset.
export const TOKEN_PURPOSE = { RESET: "reset", VERIFY: "verify" };

const insertMailedToken = async (userId, purpose, ttlMs) => {
  const { token, hash } = newToken();
  await pool.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at, purpose)
     VALUES ($1, $2, NOW() + ($3 || ' milliseconds')::interval, $4)`,
    [userId, hash, ttlMs, purpose]
  );
  return token;
};

// Exported for the admin path that changes somebody's address
// (controllersUsers.updateUser), which has to send the new one a link.
export const issueVerificationToken = (userId) =>
  insertMailedToken(userId, TOKEN_PURPOSE.VERIFY, VERIFICATION_TTL_MS);

// One statement, so spending the token and verifying the address cannot be
// separated: the CTE marks the token used only if it was still unused, and the
// UPDATE of users runs only on the row that CTE returned. Two concurrent clicks
// therefore produce one success and one "invalid or expired", rather than two
// successes on a single-use link.
export const verifyEmail = async (token) => {
  const result = await pool.query(
    `WITH spent AS (
       UPDATE password_resets SET used_at = NOW()
       WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > NOW()
       RETURNING user_id
     )
     UPDATE users SET email_verified = TRUE
     WHERE id = (SELECT user_id FROM spent)
     RETURNING id, email, role, display_name, email_verified`,
    [hashOf(token), TOKEN_PURPOSE.VERIFY]
  );
  if (result.rows.length === 0) {
    throw badRequest("This link is invalid or has expired", ERROR_CODES.INVALID_RESET_TOKEN);
  }
  return result.rows[0];
};

// Both values come from a JSON body, so they can be anything. A number or an
// object reached normalizeEmail / bcrypt.compare and threw a TypeError — a 500
// for what is a malformed request. Same answer as wrong credentials, so a type
// probe learns nothing more than a wrong password would.
export const login = async (email, password) => {
  if (typeof email !== "string" || typeof password !== "string") {
    throw unauthorized("Invalid credentials", ERROR_CODES.INVALID_CREDENTIALS);
  }
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

// ── Signing in through a provider: Google, Apple, LinkedIn ──────────────────
//
// Each provider's identity lives in its own column (008, 050). The column name
// is spliced into SQL below, so it comes ONLY from this map — never from a
// request — and an unknown provider is a programming error, not a 400.
const PROVIDER_COLUMNS = {
  google: { column: "google_id", label: "Google" },
  apple: { column: "apple_id", label: "Apple" },
  linkedin: { column: "linkedin_id", label: "LinkedIn" },
};

// A provider's picture is shown to other users as an <img src>, so it passes
// the same https-and-bounded check as one a user sets themselves. One that
// fails costs the picture, never the sign-in.
const providerAvatar = (value) => {
  try {
    return cleanAvatarUrl(value ?? null);
  } catch {
    return null;
  }
};

/**
 * Sign in — or create, or link — the account behind one provider identity.
 * The identity is already in neutral form (lib/oauthProviders.js for Apple and
 * LinkedIn, googleProfileIdentity below for Google), so every rule here holds
 * for all three alike.
 *
 * @param {"google"|"apple"|"linkedin"} provider
 * @param {{ id: string, email: string|null, emailVerified: boolean, displayName?: string|null, avatarUrl?: string|null }} identity
 */
export const oauthLogin = async (provider, identity) => {
  const known = PROVIDER_COLUMNS[provider];
  if (!known) throw new Error(`unknown sign-in provider: ${provider}`);
  const { column, label } = known;

  const email = identity.email ? normalizeEmail(identity.email) : null;
  const providerId = identity.id;
  // The provider's name is not ours to refuse, so it is cut to the column rather
  // than checked — a longer one would otherwise fail the INSERT as a 500.
  const displayName =
    typeof identity.displayName === "string" ? identity.displayName.slice(0, DISPLAY_NAME_MAX) : null;
  const avatarUrl = providerAvatar(identity.avatarUrl);

  // users.email is NOT NULL (001). An account that shares no address reached
  // the INSERT below with NULL and answered 500.
  if (!email) {
    throw unauthorized(`${label} did not share an email address for this account`, ERROR_CODES.UNAUTHORIZED);
  }

  // The provider-id match first, explicitly. `google_id=$1 OR email=$2` can
  // match TWO rows — this identity on one account, this address on another —
  // and without an order rows[0] was whichever the planner produced, which could
  // sign the caller into the wrong account.
  const existing = await pool.query(
    `SELECT * FROM users WHERE ${column}=$1 OR email=$2
     ORDER BY (${column} IS NOT DISTINCT FROM $1) DESC
     LIMIT 1`,
    [providerId, email]
  );

  if (existing.rows.length > 0) {
    const user = existing.rows[0];

    // Matched by email, but the account is already linked to a DIFFERENT
    // identity at this provider. Two accounts can claim one address over time (a
    // recycled Workspace address, a renamed account); the one already linked is
    // the one the owner proved, and the newcomer gets nothing by matching the
    // string.
    if (user[column] && user[column] !== providerId) {
      throw unauthorized(
        `This email is already linked to a different ${label} account`,
        ERROR_CODES.UNAUTHORIZED
      );
    }

    // Deactivation has to mean the same thing on every way in. login() filters on
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

    if (!user[column]) {
      // Attaching a provider identity to an account that already exists — with a
      // password, or with ANOTHER provider — is the one moment this flow can hand
      // over somebody else's account, and it is reached purely on a matching
      // email address. If the provider has not verified that address, the match
      // proves nothing.
      if (identity.emailVerified !== true) {
        throw unauthorized(
          `${label} has not verified this email address, so it cannot be linked to an existing account`,
          ERROR_CODES.UNAUTHORIZED
        );
      }
      // The provider has verified the address; this account has a password
      // nobody ever proved anything about. That password is the danger — it was
      // set by whoever typed the address into the registration form, which is not
      // necessarily the person now signing in — so it is cleared rather than left
      // as a second, unproven way into an account the rightful owner has just
      // claimed.
      //
      // Nobody is locked out: password reset issues a new one, to the address
      // the provider just confirmed. password_changed_at also ends any session
      // that password had already opened.
      const supersedesUnprovenPassword = user.password_hash && !user.email_verified;
      if (supersedesUnprovenPassword) {
        logger.warn(
          `[auth] user ${user.id} linked a verified ${label} identity to an account whose ` +
          `email was never verified — the existing password has been cleared`
        );
      }

      await pool.query(
        `UPDATE users SET
           ${column} = $1,
           avatar_url = COALESCE(avatar_url, $2),
           email_verified = TRUE,
           password_hash = CASE WHEN $4::boolean THEN NULL ELSE password_hash END,
           password_changed_at = CASE WHEN $4::boolean THEN NOW() ELSE password_changed_at END
         WHERE id = $3`,
        [providerId, avatarUrl, user.id, Boolean(supersedesUnprovenPassword)]
      );
      user[column] = providerId;
      user.email_verified = true;
    }
    const { password_hash, ...safeUser } = user;
    return safeUser;
  }

  const result = await pool.query(
    `INSERT INTO users (email, ${column}, display_name, avatar_url) VALUES ($1, $2, $3, $4)
     RETURNING id, email, role, display_name, avatar_url`,
    [email, providerId, displayName, avatarUrl]
  );
  return result.rows[0];
};

// Google tells us whether it has verified the address it is handing over, and
// the answer matters for exactly one branch of oauthLogin.
//
// The shape differs across versions of passport-google-oauth20 — the OIDC claim
// arrives on `_json`, older profile shapes put it on the email entry — so both
// are read, and anything unrecognised counts as UNVERIFIED. Defaulting the other
// way would make a future library change silently reopen the hole.
const googleProfileIdentity = (profile) => ({
  id: profile.id,
  email: profile.emails?.[0]?.value ?? null,
  emailVerified: profile?._json?.email_verified === true || profile?.emails?.[0]?.verified === true,
  displayName: profile.displayName,
  avatarUrl: profile.photos?.[0]?.value,
});

// passport's Google profile → the shared rules above.
export const googleOAuthLogin = (profile) => oauthLogin("google", googleProfileIdentity(profile));

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
    // display_name is for the socket handshake, which labels chat messages with
    // it; verifyToken still copies only id/email/role into req.user.
    "SELECT id, email, role, display_name, password_changed_at FROM users WHERE id=$1 AND is_active=TRUE",
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
// An account that signs in only through a provider (Google, Apple, LinkedIn)
// gets no token either. It has no password to reset, and
// issuing one would create a way to attach a password to an account whose owner
// only ever proved themselves through that provider.
export const requestPasswordReset = async (email) => {
  const normalizedEmail = normalizeEmail(email);
  const { rows } = await pool.query(
    "SELECT id, password_hash, locale FROM users WHERE email=$1 AND is_active=TRUE",
    [normalizedEmail]
  );
  const user = rows[0];
  if (!user) {
    logger.debug("[auth] password reset requested for an address with no active account");
    return null;
  }
  if (!user.password_hash) {
    logger.debug("[auth] password reset requested for an account that signs in through a provider");
    return null;
  }

  // The locale rides back with the token: the mail is written in the reader's
  // language, and this is the one query that knows who the reader is.
  return { token: await insertMailedToken(user.id, TOKEN_PURPOSE.RESET, RESET_TTL_MS), locale: user.locale };
};

// Spending a token: set the new password, burn every outstanding token for that
// user, and end the sessions that existed before.
//
// All three in ONE transaction, because any two of them without the third is a
// worse state than not resetting at all — a password changed while the old
// tokens still work, or sessions ended while the password did not change.
export const resetPassword = async (token, newPassword) => {
  assertUsablePassword(newPassword);
  const { userId, user } = await withTransaction(async (client) => {
    // FOR UPDATE so two confirms of the same token serialise rather than both
    // seeing it unused. `purpose` keeps a verification link from working here.
    const { rows } = await client.query(
      `SELECT id, user_id FROM password_resets
       WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > NOW()
       FOR UPDATE`,
      [hashOf(token), TOKEN_PURPOSE.RESET]
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

    return { userId, user: updated.rows[0] };
  });
  logger.info(`[auth] password reset completed for user ${userId}`);
  // The row is returned so the caller can open a session without looking the
  // token up again — it has just been burned, and a second lookup would find
  // nothing. Signing them straight in is also the point: sending someone back
  // to the login form to type the password they chose four seconds ago is a
  // step that exists only because the flow was built in two halves.
  return { user };
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
    // A provider-only account (Google, Apple, LinkedIn). Setting a first password this way would let anyone
    // with the open session add a second, permanent way in.
    throw badRequest(
      "This account signs in through Google, Apple or LinkedIn and has no password to change",
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
// `locale` arrives already checked (optionalLocale); null leaves it alone, as an
// absent name or avatar does — so the language switcher can send it alone.
export const updateProfile = async (userId, { displayName = undefined, avatarUrl = undefined, locale = null }) => {
  const trimmed = cleanDisplayName(displayName, { required: true });
  const avatar = cleanAvatarUrl(avatarUrl);

  const result = await pool.query(
    `UPDATE users SET
       display_name = COALESCE($1, display_name),
       avatar_url   = COALESCE($2, avatar_url),
       locale       = COALESCE($3, locale)
     WHERE id = $4
     RETURNING id, email, role, display_name, avatar_url, email_verified, created_at, locale`,
    [trimmed, avatar, locale, userId]
  );
  if (result.rows.length === 0) throw notFound("User not found");
  return result.rows[0];
};

export const getMe = async (userId) => {
  const result = await pool.query(
    // requested_role and approval_status ride along so the client can draw the
    // "your request is waiting" banner without a second call. They are not
    // secrets — they are this user's own row. So is the phone (migration 054):
    // the verified number and one still waiting for its code.
    `SELECT u.id, u.email, u.role, u.display_name, u.avatar_url, u.created_at,
            u.requested_role, u.approval_status, u.rejection_reason, u.locale,
            ${PHONE_STATE_SQL}
     FROM users u ${PHONE_PENDING_JOIN} WHERE u.id=$1 AND u.is_active=TRUE`,
    [userId]
  );
  if (result.rows.length === 0) throw notFound("User not found");
  const { phone_e164: _e164, ...row } = result.rows[0];
  return { ...row, ...phoneStateOf(result.rows[0]) };
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
  if (isAdmin(user)) {
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
