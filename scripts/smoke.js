import "dotenv/config";
import { pool } from "../db/pool.js";

// The check the test suite structurally cannot make: a real query, through the
// real db/pool.js, against the real database.
//
// This exists because of a bug that took the entire application down while all
// 183 tests passed. db/pool.js wraps pool.query and pool.connect to time every
// statement; the wrappers understood only the promise form, and pg uses the
// CALLBACK form internally. Every query hung forever — no error, no timeout,
// just requests that never finished. The suite could not catch it: every test
// replaces pool.query with a stub, so the wrapper never ran.
//
// test/poolInstrumentation.test.js now covers the wrapper's contract against a
// fake pg, which is the right level for CI. This covers the other half: that
// the real thing actually works end to end. It needs a database, so it is NOT
// in CI and NOT in `npm test` — run it by hand after touching db/pool.js, or
// before a deploy.
//
//   npm run smoke
//
// Read-only. It creates nothing, changes nothing and drops nothing.

const TIMEOUT_MS = 10000;

// A hang is the failure being hunted, so every step gets a deadline. Without
// one this script would reproduce the bug by hanging instead of reporting it.
const withDeadline = (promise, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`no answer within ${TIMEOUT_MS}ms — the query never completed`)), TIMEOUT_MS)
    ),
  ]).catch((err) => {
    throw new Error(`${what}: ${err.message}`);
  });

const checks = [
  // Each step is a call shape the application actually makes, in the order that
  // matters. The transaction is third on purpose: it hands an instrumented
  // client back to the pool, and the step after it is where pg reuses that
  // client through its own callback API — the exact sequence that made the
  // second half of the bug appear only after a transaction had run.
  {
    name: "pool.query, no parameters",
    run: async () => {
      const { rows } = await pool.query("SELECT 1 AS ok");
      if (rows[0].ok !== 1) throw new Error("unexpected result");
      return "1 row";
    },
  },
  {
    name: "pool.query, with parameters",
    run: async () => {
      const { rows } = await pool.query("SELECT $1::int AS n", [42]);
      if (rows[0].n !== 42) throw new Error(`expected 42, got ${rows[0].n}`);
      return "parameters bound";
    },
  },
  {
    name: "pool.connect + client.query (the transaction path)",
    run: async () => {
      const client = await pool.connect();
      try {
        const { rows } = await client.query("SELECT 2 AS tx");
        if (rows[0].tx !== 2) throw new Error("unexpected result");
        return "checked out, queried, released";
      } finally {
        client.release();
      }
    },
  },
  {
    name: "pool.query AFTER a transaction (the recycled client)",
    run: async () => {
      const { rows } = await pool.query("SELECT 3 AS after_tx");
      if (rows[0].after_tx !== 3) throw new Error("unexpected result");
      return "recycled client still usable";
    },
  },
  {
    name: "the users lookup verifyToken runs on every request",
    run: async () => {
      const { rows } = await pool.query(
        "SELECT id, email, role FROM users WHERE is_active=TRUE LIMIT 1"
      );
      return `${rows.length} row(s)`;
    },
  },
  {
    name: "the media listing the archive page loads",
    run: async () => {
      // Names the two columns migration 014 adds. A schema that has not been
      // migrated fails here rather than in the browser as a 500.
      const { rows } = await pool.query(
        "SELECT m.id, m.title, m.course_id, m.lecturer_id FROM media_items m LIMIT 1"
      );
      return `${rows.length} row(s), courses columns present`;
    },
  },
];

const run = async () => {
  console.log(`smoke: ${checks.length} checks against the real database\n`);
  let failed = 0;

  for (const check of checks) {
    const startedAt = Date.now();
    try {
      const detail = await withDeadline(check.run(), check.name);
      console.log(`  ok    ${check.name} — ${detail} (${Date.now() - startedAt}ms)`);
    } catch (err) {
      failed++;
      console.error(`  FAIL  ${err.message} (${Date.now() - startedAt}ms)`);
    }
  }

  await pool.end().catch(() => {});

  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
  // A non-zero exit makes this usable as a deploy gate.
  process.exit(failed === 0 ? 0 : 1);
};

run();
