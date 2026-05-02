import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../db/pool.js";

export const register = async (email, password, displayName) => {
  const existing = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
  if (existing.rows.length > 0) throw new Error("Email already in use");

  const password_hash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    "INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, role, display_name",
    [email, password_hash, displayName]
  );
  const user = result.rows[0];
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
  return { user, token };
};

export const login = async (email, password) => {
  const result = await pool.query("SELECT * FROM users WHERE email=$1 AND is_active=TRUE", [email]);
  if (result.rows.length === 0) throw new Error("Invalid credentials");

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new Error("Invalid credentials");

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
  const { password_hash, ...safeUser } = user;
  return { user: safeUser, token };
};

export const googleOAuthLogin = async (profile) => {
  const email = profile.emails?.[0]?.value;
  const googleId = profile.id;
  const displayName = profile.displayName;
  const avatarUrl = profile.photos?.[0]?.value;

  const existing = await pool.query("SELECT * FROM users WHERE google_id=$1 OR email=$2", [googleId, email]);

  if (existing.rows.length > 0) {
    const user = existing.rows[0];
    if (!user.google_id) {
      await pool.query("UPDATE users SET google_id=$1, avatar_url=COALESCE(avatar_url,$2) WHERE id=$3", [googleId, avatarUrl, user.id]);
      user.google_id = googleId;
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

export const getMe = async (userId) => {
  const result = await pool.query(
    "SELECT id, email, role, display_name, avatar_url, created_at FROM users WHERE id=$1 AND is_active=TRUE",
    [userId]
  );
  if (result.rows.length === 0) throw new Error("User not found");
  return result.rows[0];
};
