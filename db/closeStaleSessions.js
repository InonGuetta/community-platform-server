import "dotenv/config";
import { pool } from "./pool.js";

// One-off repair. Ending a session only ever broadcast over the socket and
// never touched the database, so every session created before that fix is still
// flagged is_active = TRUE and shows up in the active list.
//
// Deliberately a script rather than a migration: db/migrate.js re-runs every
// file on every invocation (it has no applied-migrations table and relies on
// "already exists" errors to skip), so a data fix placed there would run again
// on every deploy.
//
// Only sessions older than the cutoff are touched, so anything that might
// genuinely be running right now is left alone. Run with --dry to preview.

const STALE_AFTER = "1 day";
const dryRun = process.argv.includes("--dry");

const run = async () => {
  const { rows: candidates } = await pool.query(
    `SELECT id, title, started_at FROM live_sessions
     WHERE is_active = TRUE AND started_at < NOW() - INTERVAL '${STALE_AFTER}'
     ORDER BY started_at`
  );

  if (candidates.length === 0) {
    console.log("No stale sessions found.");
    return;
  }

  console.log(`${candidates.length} session(s) still marked active but older than ${STALE_AFTER}:`);
  for (const s of candidates) {
    console.log(`  #${s.id}  ${s.started_at?.toISOString?.() ?? s.started_at}  ${s.title || "(untitled)"}`);
  }

  if (dryRun) {
    console.log("\n--dry: nothing was changed.");
    return;
  }

  const { rowCount } = await pool.query(
    `UPDATE live_sessions
     SET is_active = FALSE, ended_at = COALESCE(ended_at, started_at)
     WHERE is_active = TRUE AND started_at < NOW() - INTERVAL '${STALE_AFTER}'`
  );
  console.log(`\nClosed ${rowCount} stale session(s).`);
};

run()
  .catch((err) => {
    console.error("Failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
