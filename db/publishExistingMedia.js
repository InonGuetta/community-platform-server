import "dotenv/config";
import { pool } from "./pool.js";

// One-off repair. is_published defaults to FALSE (migration 002) and createMedia
// never sets it, so every item ever uploaded was stored as a draft — and until
// the archive grew a publish toggle there was nothing in the app that could turn
// it on. The practical effect was that students saw an empty archive no matter
// how much material had been uploaded.
//
// This publishes what is already there. New uploads still arrive as drafts and
// are published deliberately from the card, which is the workflow the column was
// designed for.
//
// Deliberately a script rather than a migration, for the same reason as
// closeStaleSessions.js: db/migrate.js re-runs every file on every invocation, so
// a data fix placed there would re-publish items an admin had chosen to hide.
//
// Run with --dry first to see exactly what would change.

const dryRun = process.argv.includes("--dry");

const run = async () => {
  const { rows: drafts } = await pool.query(
    `SELECT m.id, m.title, m.media_type, m.created_at, u.display_name AS uploader
     FROM media_items m
     LEFT JOIN users u ON m.uploader_id = u.id
     WHERE m.is_published = FALSE
     ORDER BY m.created_at`
  );

  const { rows: [counts] } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE is_published) AS published,
       COUNT(*) FILTER (WHERE NOT is_published) AS drafts
     FROM media_items`
  );

  console.log(`Library: ${counts.published} published, ${counts.drafts} draft(s).`);

  if (drafts.length === 0) {
    console.log("Nothing to publish — every item is already visible to students.");
    return;
  }

  console.log(`\nThe following ${drafts.length} item(s) would become visible to every student:`);
  for (const m of drafts) {
    const when = m.created_at?.toISOString?.().slice(0, 10) ?? m.created_at;
    console.log(`  #${m.id}  ${when}  [${m.media_type}]  ${m.title}  — ${m.uploader || "unknown uploader"}`);
  }

  if (dryRun) {
    console.log("\n--dry: nothing was changed.");
    return;
  }

  const { rowCount } = await pool.query(
    "UPDATE media_items SET is_published = TRUE WHERE is_published = FALSE"
  );
  console.log(`\nPublished ${rowCount} item(s). They are now visible to students.`);
  console.log("Any single item can be hidden again from the archive card.");
};

run()
  .catch((err) => {
    console.error("Failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
