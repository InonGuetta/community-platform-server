// @ts-check
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { notFound, badRequest, conflict } from "../lib/AppError.js";

const ROLES = new Set(["student", "lecturer", "admin"]);
const normalizeEmail = (email) => email.trim().toLowerCase();

export const getAllUsers = async () => {
  // Admins manage every account here, including inactive ones — otherwise a
  // deactivated user would vanish from the list and could never be reactivated.
  const result = await pool.query(
    "SELECT id, email, role, display_name, avatar_url, created_at, is_active FROM users ORDER BY created_at DESC"
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
  if (!ROLES.has(role)) throw badRequest(`Invalid role: ${role}`);

  // Normalize the email the same way register/login do, so an admin can't create
  // a "Admin@X.com" that login (which lowercases) would never match.
  const normalizedEmail = normalizeEmail(email);
  const existing = await pool.query("SELECT id FROM users WHERE email=$1", [normalizedEmail]);
  if (existing.rows.length > 0) throw conflict("Email already in use");

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
    throw badRequest("Cannot remove the last active admin — promote another admin first");
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
    const normalizedEmail = email === undefined || email === null ? null : normalizeEmail(email);
    if (normalizedEmail) {
      const taken = await client.query(
        "SELECT id FROM users WHERE email=$1 AND id<>$2",
        [normalizedEmail, id]
      );
      if (taken.rows.length > 0) throw conflict("Email already in use", "EMAIL_TAKEN");
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
    if (err?.code === "23505") throw conflict("Email already in use", "EMAIL_TAKEN");
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
