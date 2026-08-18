// @ts-check
import "dotenv/config";
import { pool } from "../db/pool.js";
import { getActiveUserById } from "../services/servicesAuth.js";
import { getAllMedia, getContinueWatching } from "../services/servicesMedia.js";
import { getActiveSessions, getUpcomingSessions } from "../services/servicesSessions.js";
import { getNotesByUser } from "../services/servicesNotes.js";
import { UNRESTRICTED } from "../lib/permissions.js";

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
//   npm run smoke        directly
//   npm run verify       lint, types, tests, then this
//
// Read-only. It creates nothing, changes nothing and drops nothing — which is
// why `verify` does not also run the migrations. A command that both detects a
// stale schema and silently fixes it is one somebody eventually points at
// production to "just check something". Detection and repair stay two commands;
// when a check below fails on a missing column, the answer is `npm run migrate`.

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
  // ── From here on, the application's OWN functions ─────────────────────────
  //
  // These used to be hand-written queries labelled with the function they stood
  // for — and one of them, "the users lookup verifyToken runs on every request",
  // was a COPY of what that lookup used to be. verifyToken later grew a column
  // (password_changed_at, migration 017) and the copy did not. The result was
  // this script printing "All checks passed" against a database on which every
  // authenticated request answered 500.
  //
  // That is the third time in this codebase a hand-maintained copy drifted —
  // after db/migrate.js's file list and the ERROR_CODES mirror — so the fix is
  // the same one test/routes.test.js already uses: stop copying, call the thing.
  // A column the code needs and the schema lacks now fails HERE, by the same
  // route it would fail in the browser.
  //
  // All of these are reads. The services they come from import only pool,
  // permissions and AppError — no queue, no Redis, no OpenAI — so this stays a
  // script that talks to one database and nothing else.
  {
    name: "getActiveUserById (verifyToken, every request)",
    run: async () => {
      const { rows } = await pool.query("SELECT id FROM users WHERE is_active=TRUE LIMIT 1");
      if (rows.length === 0) return "no active users to look up — schema reachable";
      const user = await getActiveUserById(rows[0].id);
      if (!user) throw new Error("an active user was not returned by its own lookup");
      return `user ${user.id}`;
    },
  },
  {
    name: "getAllMedia (the archive listing)",
    run: async () => {
      // UNRESTRICTED exercises the visibility predicate's null branch; the empty
      // array exercises the array branch, which is the one a student gets and
      // the one that casts to int[]. Both, because they are different SQL paths.
      const all = await getAllMedia({ visibleCourses: UNRESTRICTED });
      const asStudent = await getAllMedia({ visibleCourses: [] });
      return `${all.length} visible unrestricted, ${asStudent.length} to an unenrolled student`;
    },
  },
  {
    name: "getContinueWatching (watch_progress joined to the card columns)",
    run: async () => {
      const { rows } = await pool.query("SELECT id FROM users LIMIT 1");
      if (rows.length === 0) return "no users — query shape checked only";
      const items = await getContinueWatching(rows[0].id, UNRESTRICTED);
      return `${items.length} row(s)`;
    },
  },
  {
    name: "the sessions lists (both states)",
    run: async () => {
      // getUpcomingSessions is what covers migration 018's scheduled_at, and it
      // is the only read that does.
      const [live, upcoming] = await Promise.all([getActiveSessions(), getUpcomingSessions()]);
      return `${live.length} live, ${upcoming.length} upcoming`;
    },
  },
  {
    name: "the notebook listing (notes ordered by hand)",
    run: async () => {
      // getNotesByUser is what covers migration 019's sort_order, and it is the
      // only read that does. Worth a step of its own for the reason this whole
      // script exists: the notebook is the one screen that is ENTIRELY one
      // query, so a column the code selects and the schema does not have takes
      // the page from "a feature is missing" to "the page is a 500".
      const { rows } = await pool.query("SELECT id FROM users LIMIT 1");
      if (rows.length === 0) return "no users to read a notebook for";
      const notes = await getNotesByUser(rows[0].id);
      return `${notes.length} note(s)`;
    },
  },
  {
    name: "password_resets exists",
    run: async () => {
      // The one hand-written check left, and deliberately so: nothing READS this
      // table outside a flow that needs a live token, so there is no function to
      // call. It asserts EXISTENCE rather than a query shape, which is why it
      // cannot drift the way the copies above did — there is no logic here to
      // fall out of step with.
      const { rows } = await pool.query("SELECT to_regclass('public.password_resets') AS table");
      if (!rows[0].table) throw new Error("missing — migration 017 has not been applied");
      return "present";
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
