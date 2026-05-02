import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool } from "./pool.js";

const ADMIN_EMAIL = "admin@community.local";
const ADMIN_PASSWORD = "Admin1234!";
const ADMIN_NAME = "Admin";

async function seed() {
  try {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);

    await pool.query(
      `INSERT INTO users (email, password_hash, role, display_name)
       VALUES ($1, $2, 'admin', $3)
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             role = 'admin',
             is_active = TRUE`,
      [ADMIN_EMAIL, hash, ADMIN_NAME]
    );

    console.log("Seed complete.");
    console.log(`  Email:    ${ADMIN_EMAIL}`);
    console.log(`  Password: ${ADMIN_PASSWORD}`);
  } catch (err) {
    console.error("Seed failed:", err.message);
  } finally {
    await pool.end();
  }
}

seed();
