import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool } from "./pool.js";

// Creates the first admin so a fresh install has someone who can sign in.
//
// It deliberately does NOT repair an existing one. The previous version used
// ON CONFLICT DO UPDATE with a password hard-coded in this file, which made
// re-running it silently reset the admin's password back to a value anyone with
// repository access already knew — and re-running a seed is exactly the kind of
// thing that ends up in a deploy script.
//
// Consequently there is no recovery path here for a locked-out admin, which is
// the intended trade: that should be a deliberate, manual act, not a side
// effect of running a script twice.
const ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || "admin@community.local").trim().toLowerCase();
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD;
const ADMIN_NAME = process.env.SEED_ADMIN_NAME || "Admin";

async function seed() {
  if (!ADMIN_PASSWORD) {
    console.error(
      "SEED_ADMIN_PASSWORD is not set.\n" +
      "Set it in .env (or inline for one run) and try again — there is no default on purpose."
    );
    process.exitCode = 1;
    return;
  }

  try {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);

    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, role, display_name)
       VALUES ($1, $2, 'admin', $3)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [ADMIN_EMAIL, hash, ADMIN_NAME]
    );

    if (rows.length > 0) {
      console.log(`Created admin ${ADMIN_EMAIL}.`);
    } else {
      console.log(`${ADMIN_EMAIL} already exists — left untouched.`);
    }
  } catch (err) {
    console.error("Seed failed:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

seed();
