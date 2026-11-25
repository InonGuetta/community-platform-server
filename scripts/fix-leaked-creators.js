// @ts-check
// One-off repair (UI_UX_FIXES 5.2): lessons attributed to "AI" or "ToolLLM".
//
//   npm run fix:leaked-creators -- --dry   → lists the lessons it would change
//   npm run fix:leaked-creators            → changes them
//
// Neither word is anybody's name — each is a tool's own label, sent as
// `creatorName` by an automated uploader and stored as if a person had said the
// lesson. servicesMedia.cleanCreatorName now stores "כללי" (DEFAULT_CREATOR, the
// stored "nobody was named") for either, so no new row can hold one; this puts
// the rows written before that in the same state. "כללי" rather than NULL: the
// column is NOT NULL by design (migration 020).
//
// A script rather than a migration for the reason db/closeStaleSessions.js
// gives: db/migrate.js re-runs every file on every invocation, and a data fix
// placed there would run on every deploy. Safe to run again — a second run
// finds nothing.
import "dotenv/config";
import { pool } from "../db/pool.js";
import {
  findPlaceholderCreators, clearPlaceholderCreators, PLACEHOLDER_CREATORS, DEFAULT_CREATOR,
} from "../services/servicesMedia.js";

const dryRun = process.argv.includes("--dry");

const run = async () => {
  const rows = await findPlaceholderCreators();
  if (rows.length === 0) {
    console.log(`No lesson is attributed to ${PLACEHOLDER_CREATORS.join(" / ")}.`);
    return;
  }

  console.log(`${rows.length} lesson(s) attributed to a tool's label rather than a person:`);
  for (const r of rows) {
    const at = r.created_at?.toISOString?.() ?? r.created_at;
    console.log(`  #${r.id}  ${JSON.stringify(r.creator_name)}  ${r.media_type}  uploader #${r.uploader_id ?? "-"}  ${at}  ${r.title}`);
  }

  if (dryRun) {
    console.log(`\n--dry: nothing was changed. A real run sets each to ${JSON.stringify(DEFAULT_CREATOR)}.`);
    return;
  }

  const changed = await clearPlaceholderCreators();
  console.log(`\nSet ${changed.length} lesson(s) to ${JSON.stringify(DEFAULT_CREATOR)}: ${changed.map((id) => `#${id}`).join(", ")}`);
};

run()
  .catch((err) => {
    console.error("Failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
