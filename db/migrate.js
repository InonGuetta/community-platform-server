// @ts-check
import "dotenv/config";
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { pool } from "./pool.js";

// Read from the directory, not from a list written out here.
//
// It WAS a hand-written array, and it failed exactly the way a hand-written list
// of anything fails: two migrations were added, the list was not, and `npm run
// migrate` reported "Migration complete" having silently skipped both. The
// server then started against a schema older than the code and answered 500 to
// every authenticated request — verifyToken selects a column that did not exist
// yet — which looks like an outage rather than a migration nobody ran.
//
// This is the same lesson test/routes.test.js already encodes by walking
// API_ROUTERS instead of listing routes: the thing that gets forgotten is the
// registration, not the file.
//
// Sorted lexically, which is correct BECAUSE of the zero-padded numeric prefix
// every file carries — 002 sorts before 010. A file added without that prefix
// would run in the wrong place, so the naming convention is now load-bearing and
// is asserted below.
const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

const files = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const misnamed = files.filter((name) => !/^\d{3}_/.test(name));
if (misnamed.length > 0) {
  throw new Error(
    `Migration files must start with a three-digit prefix so they run in order. ` +
    `Rename: ${misnamed.join(", ")}`
  );
}

// "This object is already there" — the expected outcome of re-running a
// migration, and the only failure that is not a failure.
//
// Matched on SQLSTATE, not on the message. It was `err.message.includes("already
// exists")`, which is prose: it swallows any genuine error whose text happens to
// contain those words, and it breaks entirely on a non-English server locale.
// The codebase already teaches this distinction — ERROR_CODES exists because
// matching the client's Hebrew on English prose broke twice — and it applies to
// Postgres' own errors just as well.
const ALREADY_EXISTS = new Set([
  "42P07", // duplicate_table
  "42710", // duplicate_object — CREATE TYPE
  "42701", // duplicate_column
  "42P06", // duplicate_schema
  "42723", // duplicate_function
  "42P16", // invalid_table_definition, raised by some duplicate constraint forms
]);

async function migrate() {
  let failed = 0;

  for (const file of files) {
    const sql = readFileSync(new URL(`./migrations/${file}`, import.meta.url), "utf8");
    try {
      await pool.query(sql);
      console.log(`✓ ${file}`);
    } catch (err) {
      if (ALREADY_EXISTS.has(err.code)) {
        console.log(`- ${file} (already exists, skipped)`);
      } else {
        failed++;
        console.error(`✗ ${file}: [${err.code ?? "no code"}] ${err.message}`);
      }
    }
  }

  await pool.end();

  // A failed migration used to print ✗ and exit 0, so this could not be used as
  // a deploy gate and a CI step running it would go green on a schema that had
  // not been applied. Same shape as scripts/smoke.js, which already exits
  // non-zero for exactly this reason.
  if (failed > 0) {
    console.error(`\n${failed} migration(s) failed. The schema is NOT up to date.`);
    process.exit(1);
  }
  console.log("Migration complete.");
}

migrate();
