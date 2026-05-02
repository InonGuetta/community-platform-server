import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";

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
  if (result.rows.length === 0) throw new Error("User not found");
  return result.rows[0];
};

export const createUser = async (data) => {
  const { email, password, role = "student", displayName } = data;
  const password_hash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    "INSERT INTO users (email, password_hash, role, display_name) VALUES ($1, $2, $3, $4) RETURNING id, email, role, display_name, created_at",
    [email, password_hash, role, displayName]
  );
  return result.rows[0];
};

export const updateUser = async (id, data) => {
  const { email, role, displayName, avatarUrl, isActive } = data;
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
  if (result.rows.length === 0) throw new Error("User not found");
  return result.rows[0];
};

export const deleteUser = async (id) => {
  const result = await pool.query(
    "UPDATE users SET is_active=FALSE WHERE id=$1 RETURNING id",
    [id]
  );
  if (result.rows.length === 0) throw new Error("User not found");
  return { deleted: true, id };
};
