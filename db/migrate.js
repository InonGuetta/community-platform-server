import "dotenv/config";
import { readFileSync } from "fs";
import { pool } from "./pool.js";

const files = [
  "001_create_users.sql",
  "002_create_media.sql",
  "003_create_sessions.sql",
  "004_create_transcripts.sql",
  "005_create_bookmarks.sql",
  "006_create_donations.sql",
  "007_create_transcript_chunks.sql",
  "008_add_google_oauth.sql",
  "009_add_key_point_headings.sql",
];

async function migrate() {
  for (const file of files) {
    const sql = readFileSync(new URL(`./migrations/${file}`, import.meta.url), "utf8");
    try {
      await pool.query(sql);
      console.log(`✓ ${file}`);
    } catch (err) {
      if (err.message.includes("already exists")) {
        console.log(`- ${file} (already exists, skipped)`);
      } else {
        console.error(`✗ ${file}: ${err.message}`);
      }
    }
  }
  await pool.end();
  console.log("Migration complete.");
}

migrate();
