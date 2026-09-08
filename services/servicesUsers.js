// @ts-check
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { notFound, badRequest, conflict, ERROR_CODES } from "../lib/AppError.js";
import { assertUsableEmail } from "../lib/validate.js";

const ROLES = new Set(["student", "lecturer", "admin"]);
const normalizeEmail = (email) => email.trim().toLowerCase();

export const getAllUsers = async () => {
  // Admins manage every account here, including inactive ones — otherwise a
  // deactivated user would vanish from the list and could never be reactivated.
  const result = await pool.query(
    // The approval columns ride along rather than being a second endpoint: the
    // users tab renders one table and needs both halves of every row at once,
    // and a separate "pending" call would make the two disagree while it loaded.
    `SELECT id, email, role, display_name, avatar_url, created_at, is_active,
            requested_role, approval_status, approved_by, approved_at, rejection_reason
     FROM users ORDER BY created_at DESC`
  );
  return result.rows;
};

export const getUserById = async (id) => {
  const result = await pool.query(
    "SELECT id, email, role, display_name, avatar_url, created_at, is_active FROM users WHERE id=$1",
    [id]
  );
  if (result.rows.length === 0) throw notFound("User not found");
  return result.rows[0];
};

export const createUser = async (data) => {
  const { email, password, role = "student", displayName } = data;
  if (!email || !password) throw badRequest("Email and password are required");
  // An admin typing somebody else's address is at least as likely to slip as the
  // owner typing their own, and the person who suffers cannot see the form.
  assertUsableEmail(email);
  if (!ROLES.has(role)) throw badRequest(`Invalid role: ${role}`);

  // Normalize the email the same way register/login do, so an admin can't create
  // a "Admin@X.com" that login (which lowercases) would never match.
  const normalizedEmail = normalizeEmail(email);
  const existing = await pool.query("SELECT id FROM users WHERE email=$1", [normalizedEmail]);
  if (existing.rows.length > 0) throw conflict("Email already in use", ERROR_CODES.EMAIL_TAKEN);

  const password_hash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    "INSERT INTO users (email, password_hash, role, display_name) VALUES ($1, $2, $3, $4) RETURNING id, email, role, display_name, created_at",
    [normalizedEmail, password_hash, role, displayName]
  );
  return result.rows[0];
};

// Refuse an update that would leave the system with no active admin — a state
// nobody can recover from through the UI. "Active" is the operative word:
// promoting a replacement first always makes the demotion legal.
//
// The SELECT ... FOR UPDATE is what makes this safe under concurrency. Two
// admins being demoted at the same time would otherwise each see the other as
// still active and both succeed. Locking the active-admin set serialises them,
// and the ORDER BY gives both transactions the same lock order so they queue
// instead of deadlocking.
const assertAdminRemains = async (client, id, current, { role, isActive }) => {
  const wasActiveAdmin = current.role === "admin" && current.is_active;
  if (!wasActiveAdmin) return;

  const staysAdmin = (role ?? "admin") === "admin" && (isActive ?? true) !== false;
  if (staysAdmin) return;

  const { rows } = await client.query(
    "SELECT id FROM users WHERE role='admin' AND is_active=TRUE ORDER BY id FOR UPDATE"
  );
  const others = rows.filter((row) => row.id !== Number(id));
  if (others.length === 0) {
    throw badRequest("Cannot remove the last active admin — promote another admin first", ERROR_CODES.LAST_ACTIVE_ADMIN);
  }
};

// Shared by updateUser and deleteUser: both mutate a user row and both have to
// pass the last-admin guard, inside one transaction so the guard and the write
// can't be separated.
//
// Every field is optional, and that is the contract the UPDATE below relies on:
// each column is written with COALESCE, so an absent field leaves the column
// alone. Spelled out because deleteUser passes only { isActive } — without the
// annotation the parameter's shape is inferred from updateUser's fuller object
// and that call reads as missing four required fields.
/**
 * @param {number|string} id
 * @param {{
 *   email?: string|null,
 *   role?: string|null,
 *   displayName?: string|null,
 *   avatarUrl?: string|null,
 *   isActive?: boolean|null,
 * }} fields
 */
const updateUserRow = async (id, { email, role, displayName, avatarUrl, isActive }) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query("SELECT role, is_active FROM users WHERE id=$1", [id]);
    if (existing.rows.length === 0) throw notFound("User not found");

    // createUser normalizes the email; without the same treatment here an admin
    // could save "Admin@X.com", which login (which lowercases) would never match.
    if (email !== undefined && email !== null) assertUsableEmail(email);
    const normalizedEmail = email === undefined || email === null ? null : normalizeEmail(email);
    if (normalizedEmail) {
      const taken = await client.query(
        "SELECT id FROM users WHERE email=$1 AND id<>$2",
        [normalizedEmail, id]
      );
      if (taken.rows.length > 0) throw conflict("Email already in use", ERROR_CODES.EMAIL_TAKEN);
    }

    await assertAdminRemains(client, id, existing.rows[0], { role, isActive });

    const result = await client.query(
      `UPDATE users SET
        email = COALESCE($1, email),
        role = COALESCE($2, role),
        display_name = COALESCE($3, display_name),
        avatar_url = COALESCE($4, avatar_url),
        is_active = COALESCE($5, is_active)
      WHERE id=$6
      RETURNING id, email, role, display_name, avatar_url, is_active`,
      [normalizedEmail, role, displayName, avatarUrl, isActive, id]
    );

    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // Backstop for a race the check above can't cover: two admins claiming the
    // same new email at once. Postgres' unique index is the real guarantee.
    if (err?.code === "23505") throw conflict("Email already in use", ERROR_CODES.EMAIL_TAKEN);
    throw err;
  } finally {
    client.release();
  }
};

export const updateUser = async (id, data) => {
  const { role, isActive } = data;
  if (role !== undefined && !ROLES.has(role)) throw badRequest(`Invalid role: ${role}`);
  if (isActive !== undefined && isActive !== null && typeof isActive !== "boolean") {
    throw badRequest("isActive must be a boolean");
  }
  return updateUserRow(id, data);
};

// Soft delete — deactivation, so it goes through the same guard as any other
// is_active change. Deleting the last admin is exactly as unrecoverable as
// demoting them.
export const deleteUser = async (id) => {
  await updateUserRow(id, { isActive: false });
  return { deleted: true, id };
};

// ── Role approval ───────────────────────────────────────────────────────────
//
// Somebody asked to be a lecturer or an admin at signup; an admin decides.
// Migration 021 explains why the request lives in its own columns rather than in
// users.role, and servicesAuth.register explains why nothing else may write it.
// This is the ONLY function that moves requested_role across into role.

// The waiting list, oldest first — a queue, so the person who has been waiting
// longest is at the top rather than buried under later signups.
export const getPendingApprovals = async () => {
  const result = await pool.query(
    `SELECT id, email, display_name, requested_role, created_at
     FROM users
     WHERE approval_status = 'pending'
     ORDER BY created_at ASC`
  );
  return result.rows;
};

// Loads the row and checks it is genuinely awaiting a decision, inside the same
// transaction as the write.
//
// FOR UPDATE, and it is load-bearing: two admins opening the tab and both
// pressing approve would otherwise both read 'pending' and both write, and the
// second would overwrite approved_by with a second name for one decision. The
// lock makes the loser see 'approved' and refuse.
const lockPending = async (client, id) => {
  const { rows } = await client.query(
    "SELECT id, email, display_name, requested_role, approval_status FROM users WHERE id=$1 FOR UPDATE",
    [id]
  );
  if (rows.length === 0) throw notFound("User not found");
  const user = rows[0];
  if (user.approval_status !== "pending") {
    throw conflict("This request has already been decided", ERROR_CODES.CONFLICT);
  }
  return user;
};

/**
 * Grants the requested role.
 *
 * @param {number|string} id       the applicant
 * @param {number|string} adminId  the admin deciding — stamped onto the row
 */
export const approveUser = async (id, adminId) => {
  // An admin approving their own application would be the whole feature
  // defeated: sign up as an admin, then approve yourself. Enforced here rather
  // than only by hiding the button, because the button is not the security
  // boundary.
  if (Number(id) === Number(adminId)) {
    throw badRequest("You cannot approve your own request");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = await lockPending(client, id);

    // The role and the status move in ONE statement. Two statements would leave
    // a window in which somebody holds the role while still reading as pending,
    // and the users tab would offer to approve an account that already has it.
    const result = await client.query(
      `UPDATE users SET
         role = $1,
         approval_status = 'approved',
         approved_by = $2,
         approved_at = NOW(),
         rejection_reason = NULL
       WHERE id = $3
       RETURNING id, email, role, display_name, requested_role, approval_status, approved_at`,
      [user.requested_role, adminId, id]
    );

    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Refuses the request. The account stays a working student account.
 *
 * Deliberately not a deletion and not a deactivation: somebody who asked to
 * teach and was told no is still a member, and destroying their account over it
 * would be a surprising amount of damage for a "no". `reason` is optional and
 * is what the notification email quotes.
 */
export const rejectUser = async (id, adminId, reason = null) => {
  if (Number(id) === Number(adminId)) {
    throw badRequest("You cannot decide your own request");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockPending(client, id);

    const result = await client.query(
      // role is untouched — it has been 'student' since registration and stays
      // there. approved_by/approved_at record who decided, which is as true of a
      // refusal as of a grant.
      `UPDATE users SET
         approval_status = 'rejected',
         approved_by = $1,
         approved_at = NOW(),
         rejection_reason = $2
       WHERE id = $3
       RETURNING id, email, role, display_name, requested_role, approval_status, rejection_reason`,
      [adminId, reason || null, id]
    );

    await client.query("COMMIT");
    return result.rows[0];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};
