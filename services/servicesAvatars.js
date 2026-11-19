// @ts-check
// A user's own profile picture: uploaded, replaced, removed, and found again
// to be served (migration 052).
//
// The file is stored like any other (lib/storage.js) and its key kept in
// users.avatar_key; users.avatar_url — what every screen already shows as an
// <img src> — becomes this API's address for it, with ?v=<when> so a new
// picture is never hidden behind the browser's cached copy of the old one.
//
// A replaced or removed picture's file is deleted after the row no longer
// points at it, and a failure to delete it is only logged: by then the user's
// change has happened, and an orphaned file costs a few kilobytes.
import { pool } from "../db/pool.js";
import { notFound, ERROR_CODES } from "../lib/AppError.js";
import { storeBuffer, removeStored } from "../lib/storage.js";
import { logger } from "../lib/logger.js";

// The size limit the upload route enforces. The client shrinks a picture to a
// few dozen kilobytes before sending it, so this only stops a raw upload.
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

// What the account page and the navbar read back — the same columns
// updateProfile returns.
const ACCOUNT_COLUMNS = "id, email, role, display_name, avatar_url, email_verified, created_at, locale";

/** The address a stored picture is served at. @param {number} userId */
export const avatarUrlFor = (userId, now = Date.now()) => `/api/auth/avatar/${userId}?v=${now}`;

/** @param {string | null | undefined} key */
const dropFile = async (key) => {
  if (!key) return;
  await removeStored(key, { missingOk: true }).catch((err) =>
    logger.warn(`[avatar] could not delete the previous picture: ${err.message}`)
  );
};

/**
 * Store a new picture as this user's avatar, replacing any previous one.
 * `ext` comes from the picture's bytes (requireAvatarImage), never the request.
 *
 * @param {number} userId
 * @param {{ buffer: Buffer, ext: string }} image
 */
export const setAvatar = async (userId, { buffer, ext }) => {
  const now = Date.now();
  const key = await storeBuffer(`avatar-${userId}-${now}.${ext}`, buffer, { folder: "avatars" });
  let result;
  try {
    // The previous key in the same statement: the CTE reads the row as it was
    // before this UPDATE wrote it.
    result = await pool.query(
      `WITH previous AS (SELECT avatar_key FROM users WHERE id = $3)
       UPDATE users SET avatar_key = $1, avatar_url = $2
        WHERE id = $3 AND is_active = TRUE
       RETURNING (SELECT avatar_key FROM previous) AS previous_key, ${ACCOUNT_COLUMNS}`,
      [key, avatarUrlFor(userId, now), userId]
    );
  } catch (err) {
    await dropFile(key);
    throw err;
  }
  if (result.rows.length === 0) {
    await dropFile(key);
    throw notFound("User not found");
  }
  const { previous_key: previousKey, ...user } = result.rows[0];
  await dropFile(previousKey);
  return user;
};

/**
 * Remove this user's avatar — an uploaded one with its file, or a provider's
 * address (which a later Google sign-in may bring back, as it fills an empty
 * avatar).
 *
 * @param {number} userId
 */
export const removeAvatar = async (userId) => {
  const result = await pool.query(
    `WITH previous AS (SELECT avatar_key FROM users WHERE id = $1)
     UPDATE users SET avatar_key = NULL, avatar_url = NULL
      WHERE id = $1 AND is_active = TRUE
     RETURNING (SELECT avatar_key FROM previous) AS previous_key, ${ACCOUNT_COLUMNS}`,
    [userId]
  );
  if (result.rows.length === 0) throw notFound("User not found");
  const { previous_key: previousKey, ...user } = result.rows[0];
  await dropFile(previousKey);
  return user;
};

/**
 * Where a user's uploaded picture is stored, to be served. A user with none —
 * or a provider's picture, which is not ours to serve — is a 404.
 *
 * @param {number} userId
 * @returns {Promise<string>}
 */
export const avatarKeyOf = async (userId) => {
  const { rows } = await pool.query(
    "SELECT avatar_key FROM users WHERE id = $1 AND is_active = TRUE AND avatar_key IS NOT NULL",
    [userId]
  );
  if (rows.length === 0) throw notFound("No picture", ERROR_CODES.NOT_FOUND);
  return rows[0].avatar_key;
};
