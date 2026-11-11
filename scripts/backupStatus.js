// @ts-check
// ── What a backup has to hold, and whether a restore holds it (PRD NFR-2) ────
//
//   npm run backup:status                        the picture, for a person
//   npm run backup:status -- --json > before.json
//   npm run backup:status -- --compare before.json
//                                                the restore drill: run against
//                                                the RESTORED database and say
//                                                what differs from the snapshot
//
// Read-only. Two halves, because they are backed up by different things:
//
//   the database  Supabase's own backups, or pg_dump (BACKUP.md). Fingerprinted
//                 by row counts of the tables that hold what people made, and
//                 by whether the newest migrations' tables exist — a restore
//                 from an old backup is behind the code, and this says so.
//   the media     the files a database backup does NOT contain. Rows whose file
//                 is on this machine's disk only (s3_key "local/…") have no
//                 copy anywhere until they are moved to S3; rows whose file is
//                 already missing cannot be restored by anything.
//
// No content is printed — counts, sizes and ids only.
import "dotenv/config";
import fs from "fs";
import path from "path";

// --json is meant for `> before.json`, and the logger writes its debug lines
// to stdout: quieten it BEFORE it is loaded — it reads LOG_LEVEL once, at
// import — which is why everything that logs is imported dynamically below.
if (process.argv.includes("--json")) process.env.LOG_LEVEL = "warn";
const load = async () => ({
  ...(await import("../db/pool.js")),
  ...(await import("../lib/storage.js")),
  ...(await import("../services/servicesSessionRecordings.js")),
});

// What people made — a restore that loses any of it lost real work.
const TABLES = [
  "users", "courses", "enrollments", "media_items", "transcripts", "transcript_chunks",
  "notes", "bookmarks", "tags", "media_tags", "ai_conversations", "ai_messages",
  "donations", "live_sessions", "session_recordings", "notifications",
];

// The newest migrations' tables, newest first: the first one missing says how
// far behind a restored database is.
const NEWEST = [
  ["049", "media_session_chat"],
  ["048", "session_recordings"],
  ["044", "media_ai_tag_suggestions"],
  ["041", "transcript_timings"],
  ["040", "ai_usage"],
  ["035", "notifications"],
];

const snapshot = async ({ pool, isLocalKey, localPathOf, s3Configured, PARTS_DIR }) => {
  const { rows: [size] } = await pool.query("SELECT pg_database_size(current_database())::bigint AS bytes");
  const counts = {};
  for (const table of TABLES) {
    const { rows: [exists] } = await pool.query("SELECT to_regclass($1) AS t", [`public.${table}`]);
    counts[table] = exists.t ? Number((await pool.query(`SELECT COUNT(*)::bigint AS n FROM ${table}`)).rows[0].n) : null;
  }
  const schema = {};
  for (const [migration, table] of NEWEST) {
    const { rows: [exists] } = await pool.query("SELECT to_regclass($1) AS t", [`public.${table}`]);
    schema[migration] = Boolean(exists.t);
  }

  const { rows: media } = await pool.query("SELECT id, s3_key FROM media_items ORDER BY id");
  const local = [];
  const missing = [];
  let localBytes = 0;
  for (const m of media) {
    if (!isLocalKey(m.s3_key)) continue;
    const file = localPathOf(m.s3_key);
    if (fs.existsSync(file)) {
      local.push(m.id);
      localBytes += fs.statSync(file).size;
    } else {
      missing.push(m.id);
    }
  }
  const unfinishedRecordings = fs.existsSync(PARTS_DIR) ? fs.readdirSync(PARTS_DIR).length : 0;

  return {
    takenAt: new Date().toISOString(),
    database: { bytes: Number(size.bytes), counts, schema },
    media: {
      total: media.length,
      onS3: media.length - local.length - missing.length,
      localOnly: local.length,
      localOnlyBytes: localBytes,
      missingFiles: missing,
      s3Configured: s3Configured(),
      unfinishedRecordings,
    },
  };
};

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)}MB`;

const print = (s) => {
  const lines = [];
  lines.push(`Database: ${mb(s.database.bytes)}`);
  for (const [table, n] of Object.entries(s.database.counts)) lines.push(`  ${table.padEnd(20)} ${n === null ? "(no such table)" : n}`);
  const behind = Object.entries(s.database.schema).filter(([, ok]) => !ok).map(([m]) => m);
  lines.push(behind.length ? `  schema: BEHIND — no table from migration(s) ${behind.join(", ")}; run npm run migrate` : "  schema: current (049)");
  lines.push("");
  lines.push(`Media: ${s.media.total} item(s)`);
  lines.push(`  on S3                ${s.media.onS3}`);
  lines.push(`  on this disk ONLY    ${s.media.localOnly} (${mb(s.media.localOnlyBytes)})${s.media.localOnly ? " — no copy anywhere; see BACKUP.md" : ""}`);
  lines.push(`  file missing         ${s.media.missingFiles.length}${s.media.missingFiles.length ? ` — ids ${s.media.missingFiles.join(", ")}` : ""}`);
  lines.push(`  S3 configured        ${s.media.s3Configured ? "yes" : "no"}`);
  if (s.media.unfinishedRecordings) lines.push(`  unfinished recordings ${s.media.unfinishedRecordings} (joined when their session ends)`);
  return lines.join("\n");
};

/**
 * What a restored database lacks against the snapshot. Exported for the tests.
 * More rows than the snapshot is fine — the live database kept working.
 * @param {any} before
 * @param {any} after
 */
export const compareSnapshots = (before, after) => {
  const problems = [];
  for (const [table, n] of Object.entries(before.database.counts)) {
    const now = after.database.counts[table];
    if (n === null) continue;
    if (now === null || now === undefined) problems.push(`${table}: missing (had ${n} rows)`);
    else if (now < n) problems.push(`${table}: ${now} rows, had ${n}`);
  }
  for (const [migration, ok] of Object.entries(before.database.schema)) {
    if (ok && !after.database.schema[migration]) problems.push(`schema: migration ${migration}'s table is missing`);
  }
  return problems;
};

const main = async (deps) => {
  const args = process.argv.slice(2);
  const s = await snapshot(deps);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${print(s)}\n`);
  const at = args.indexOf("--compare");
  if (at !== -1) {
    const before = JSON.parse(fs.readFileSync(args[at + 1], "utf8"));
    const problems = compareSnapshots(before, s);
    process.stdout.write(problems.length
      ? `\nRESTORE CHECK FAILED against ${before.takenAt}:\n${problems.map((p) => `  ✗ ${p}`).join("\n")}\n`
      : `\nRestore check passed: nothing in the snapshot of ${before.takenAt} is missing.\n`);
    if (problems.length) process.exitCode = 1;
  }
};

// Run only as a script — the tests import compareSnapshots.
if (path.basename(process.argv[1] ?? "") === "backupStatus.js") {
  const deps = await load();
  main(deps)
    .catch((err) => {
      process.stderr.write(`backup:status failed: ${err.message}\n`);
      process.exitCode = 1;
    })
    .finally(() => deps.pool.end());
}
