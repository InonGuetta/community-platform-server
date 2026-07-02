import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { notFound, badRequest, conflict } from "../lib/AppError.js";

const ROLES = new Set(["student", "lecturer", "admin"]);
const normalizeEmail = (email) => email.trim().toLowerCase();

export const getAllUsers = async () => {
  const result = await pool.query(
    "SELECT id, email, role, display_name, avatar_url, created_at, is_active FROM users WHERE is_active=TRUE ORDER BY created_at DESC"
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

export const updateUser = async (id, data) => {
  const { email, role, displayName, avatarUrl, isActive } = data;
  if (role !== undefined && !ROLES.has(role)) throw badRequest(`Invalid role: ${role}`);
  const result = await pool.query(
    `UPDATE users SET
      email = COALESCE($1, email),
      role = COALESCE($2, role),
      display_name = COALESCE($3, display_name),
      avatar_url = COALESCE($4, avatar_url),
      is_active = COALESCE($5, is_active)
    WHERE id=$6
    RETURNING id, email, role, display_name, avatar_url, is_active`,
    [email, role, displayName, avatarUrl, isActive, id]
  );
  if (result.rows.length === 0) throw notFound("User not found");
  return result.rows[0];
};

export const deleteUser = async (id) => {
  const result = await pool.query(
    "UPDATE users SET is_active=FALSE WHERE id=$1 RETURNING id",
    [id]
  );
  if (result.rows.length === 0) throw notFound("User not found");
  return { deleted: true, id };
};
