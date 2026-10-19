// @ts-check
import "dotenv/config";
import { pool } from "../db/pool.js";
import { getActiveUserById } from "../services/servicesAuth.js";
import { getAllMedia, getContinueWatching } from "../services/servicesMedia.js";
import { MEDIA_SORTS } from "../lib/validate.js";
import { getActiveSessions, getUpcomingSessions } from "../services/servicesSessions.js";
import { getNotesByUser } from "../services/servicesNotes.js";
import { getPendingApprovals } from "../services/servicesUsers.js";
import { getStudentsOfLecturer, searchEnrollableUsers } from "../services/servicesCourses.js";
import {
  getBookmarksByUser, createBookmark, deleteBookmark,
} from "../services/servicesBookmarks.js";
import {
  proposeTag, getPendingProposalsForMedia, getPendingProposals,
  approveTagProposal, rejectTagProposal, withdrawProposal,
} from "../services/servicesTags.js";
import { getPlaylists, ITEMS_PER_LIST } from "../services/servicesSaves.js";
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
// Read-only, with three deliberate exceptions, all of them about bookmarks: two
// write inside a transaction that is ALWAYS rolled back, and the round trip
// below writes for real through the service and deletes what it wrote. They are
// the only way to ask the real constraints and the real service the questions
// `npm test` structurally cannot, since the suite stubs the pool. Nothing else
// here creates, changes or drops anything — which is
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
      // Both dimensions, as an admin gets them, then as a student in no course.
      const all = await getAllMedia({ visibleCourses: UNRESTRICTED, visibleDrafts: UNRESTRICTED });
      const asStudent = await getAllMedia({ visibleCourses: [], visibleDrafts: [] });
      return `${all.length} visible unrestricted, ${asStudent.length} to an unenrolled student`;
    },
  },
  {
    name: "getAllMedia with several media types (the enum-array cast)",
    run: async () => {
      // `= ANY($n::media_type[])` is a cast the planner either accepts or does
      // not, and the suite only ever sees it as a string.
      const scope = { visibleCourses: UNRESTRICTED, visibleDrafts: UNRESTRICTED };
      const all = await getAllMedia(scope);
      const two = await getAllMedia({ ...scope, types: ["video", "audio"] });
      const one = await getAllMedia({ ...scope, types: ["video"] });
      if (one.length > two.length || two.length > all.length) {
        throw new Error("a wider type filter returned FEWER rows than a narrower one");
      }
      return `${one.length} video, ${two.length} video+audio, ${all.length} unfiltered`;
    },
  },
  {
    name: "getAllMedia in every sort order (the ORDER BY each name stands for)",
    run: async () => {
      // The route tests assert on the ORDER BY as a string. Only a real planner
      // can say whether it parses — `like_count` names an output column, which
      // ORDER BY accepts only as a bare name, and a reshuffle that wrapped it in
      // an expression would pass every stubbed test and fail here.
      const scope = { visibleCourses: UNRESTRICTED, visibleDrafts: UNRESTRICTED };
      const counts = [];
      for (const sort of MEDIA_SORTS) {
        const rows = await getAllMedia({ ...scope, sort });
        counts.push(rows.length);
      }
      if (new Set(counts).size > 1) {
        throw new Error(`the sort changed how many rows came back: ${counts.join(", ")}`);
      }
      return `${MEDIA_SORTS.length} orders, ${counts[0]} rows each`;
    },
  },
  {
    name: "getAllMedia by length (duration_seconds, documents left out)",
    run: async () => {
      // Real rows, real planner. The ranges are the client's buckets; together
      // they must account for every recording with a known length exactly once,
      // which is what min-inclusive / max-exclusive promises.
      const scope = { visibleCourses: UNRESTRICTED, visibleDrafts: UNRESTRICTED };
      const buckets = [
        { maxDuration: 900 },
        { minDuration: 900, maxDuration: 1800 },
        { minDuration: 1800, maxDuration: 3600 },
        { minDuration: 3600 },
      ];
      const counts = [];
      for (const range of buckets) {
        const rows = await getAllMedia({ ...scope, ...range });
        if (rows.some((r) => r.media_type === "text" || r.duration_seconds === null)) {
          throw new Error("a length range returned a document or a recording of unknown length");
        }
        counts.push(rows.length);
      }
      const { rows: [{ n }] } = await pool.query(
        "SELECT COUNT(*)::int AS n FROM media_items WHERE media_type <> 'text' AND duration_seconds IS NOT NULL"
      );
      const sum = counts.reduce((a, b) => a + b, 0);
      if (sum !== n) throw new Error(`the ranges hold ${sum} recordings between them, but ${n} have a length`);
      return `${counts.join(" + ")} = ${n} recordings with a length, each in exactly one range`;
    },
  },
  {
    name: "getAllMedia with both tag lists (the recursive walks)",
    run: async () => {
      // The half the suite structurally cannot check. Every test stubs pool.query
      // and asserts on the SQL as a STRING, so a query that is well-shaped and
      // syntactically invalid — a shadowed CTE name, a cast the planner refuses,
      // a column that moved — passes every one of them and fails only here.
      //
      // Two recursive CTEs now live in one statement, which is precisely the
      // arrangement a name collision would break. Run against real ids taken
      // from the table so the walks actually descend rather than starting from
      // nothing; if there are no tags yet, the shapes are still parsed and
      // planned, which is most of what this is for.
      const { rows } = await pool.query(
        `SELECT id FROM tags WHERE parent_id IS NULL ORDER BY id LIMIT 2`
      );
      const [first, second] = rows.map((r) => r.id);
      const scope = { visibleCourses: UNRESTRICTED, visibleDrafts: UNRESTRICTED };

      const chosen = await getAllMedia({ ...scope, tagIds: first ? [first] : [] });
      // "Everything except X", with no positive choice — the standalone path.
      const without = await getAllMedia({ ...scope, excludeTagIds: second ? [second] : [] });
      // And both at once, which is the arrangement the UI actually produces.
      const both = await getAllMedia({
        ...scope,
        tagIds: first ? [first] : [],
        excludeTagIds: second ? [second] : [],
      });

      if (rows.length === 0) return "no tags yet — both query shapes planned only";
      if (both.length > chosen.length) {
        throw new Error("excluding a tag returned MORE rows than choosing alone");
      }
      return `${chosen.length} chosen, ${without.length} after one exclusion, ${both.length} with both`;
    },
  },
  {
    name: "getContinueWatching (watch_progress joined to the card columns)",
    run: async () => {
      const { rows } = await pool.query("SELECT id FROM users LIMIT 1");
      if (rows.length === 0) return "no users — query shape checked only";
      const items = await getContinueWatching(rows[0].id, { courses: UNRESTRICTED, drafts: UNRESTRICTED });
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
  // ── The three most recent migrations ──────────────────────────────────────
  //
  // Every check below calls the application's OWN service function rather than a
  // copy of its query, which is the property the file's other checks were
  // rewritten for: a copy passes cheerfully against a database the real code
  // cannot run on. The check labelled "the users lookup verifyToken runs" WAS
  // such a copy, and after verifyToken grew a column the copy did not, it went
  // on passing while nothing in the application worked.
  //
  // These are also the only evidence that migrations 020–022 were applied at
  // all: `npm test` stubs the pool, so a missing column is invisible there and
  // shows up as a 500 on the first real request instead.
  {
    name: "creator_name on the archive listing (migration 020)",
    run: async () => {
      const items = await getAllMedia({ visibleCourses: UNRESTRICTED, visibleDrafts: UNRESTRICTED });
      // An empty library is a legitimate state and must not fail the check — but
      // it also proves nothing, so say so rather than reporting a pass.
      if (items.length === 0) return "no media to inspect (column not exercised)";
      const missing = items.filter((i) => i.creator_name === undefined);
      if (missing.length > 0) {
        throw new Error("creator_name is absent — migration 020 has not been applied");
      }
      // The NOT NULL default is the backfill. A null here means the column was
      // added by hand without it, and every card would render an empty byline.
      const nulls = items.filter((i) => i.creator_name === null);
      if (nulls.length > 0) {
        throw new Error(`${nulls.length} row(s) have a NULL creator_name — the DEFAULT did not apply`);
      }
      return `${items.length} item(s), all attributed`;
    },
  },
  {
    name: "the approval queue (migration 021)",
    run: async () => {
      // Exercises requested_role, approval_status AND the partial index's
      // predicate in one call. An empty queue is the normal state.
      const pending = await getPendingApprovals();
      return `${pending.length} request(s) waiting`;
    },
  },
  {
    name: "a lecturer's students, grouped (migration 014 + R4)",
    run: async () => {
      const { rows } = await pool.query("SELECT id FROM users WHERE role='lecturer' LIMIT 1");
      if (rows.length === 0) return "no lecturer to ask about";
      // json_agg over a three-table join — the query most likely to break on a
      // schema change, and the one no unit test executes.
      const students = await getStudentsOfLecturer(rows[0].id);
      return `${students.length} distinct student(s)`;
    },
  },
  {
    name: "the enrollable-user search (R4)",
    run: async () => {
      const { rows } = await pool.query("SELECT id FROM courses LIMIT 1");
      if (rows.length === 0) return "no course to search within";
      // Two characters, so it goes past the minimum-length guard and actually
      // runs the SQL — the point of the check. A term that matches nothing is
      // fine; an exception is not.
      const found = await searchEnrollableUsers(rows[0].id, "aa");
      if (!Array.isArray(found)) throw new Error("the search did not return a list");
      return `${found.length} match(es) for a probe term`;
    },
  },
  {
    name: "bookmarks anchored to text (migration 022)",
    run: async () => {
      const { rows } = await pool.query("SELECT id FROM users LIMIT 1");
      if (rows.length === 0) return "no users";
      // char_position is in the SELECT * this returns, so its absence surfaces
      // here rather than as a reader that silently marks nothing.
      const bookmarks = await getBookmarksByUser(rows[0].id, null);
      const column = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name='bookmarks' AND column_name='char_position'`
      );
      if (column.rows.length === 0) {
        throw new Error("bookmarks.char_position is missing — migration 022 has not been applied");
      }
      // The nullability change is the other half of 022, and the half a bookmark
      // in a book fails on: with the column still NOT NULL every text bookmark
      // is rejected by the driver.
      const nullable = await pool.query(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_name='bookmarks' AND column_name='timestamp_seconds'`
      );
      if (nullable.rows[0]?.is_nullable !== "YES") {
        throw new Error("bookmarks.timestamp_seconds is still NOT NULL — migration 022 is half-applied");
      }
      return `${bookmarks.length} bookmark(s), both anchors available`;
    },
  },
  {
    name: "bookmarks hold a passage, not a point (migration 026)",
    run: async () => {
      // Every one of these is written by createBookmark on the text path, so a
      // missing column is not a degraded feature — it is a 500 on every attempt
      // to mark anything in a book.
      const wanted = ["char_end", "chunk_id", "quoted_text", "page_number"];
      const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name='bookmarks' AND column_name = ANY($1)`,
        [wanted]
      );
      const missing = wanted.filter((c) => !rows.some((r) => r.column_name === c));
      if (missing.length > 0) {
        throw new Error(`bookmarks is missing ${missing.join(", ")} — migration 026 has not been applied`);
      }

      // ── The check this whole entry exists for ────────────────────────────
      //
      // chunk_id references transcript_chunks, and writeChunks DELETEs every
      // chunk of a media item on every pipeline run. If this key is ever
      // re-created as CASCADE, one press of "הפק סיכום מחדש" silently deletes
      // every bookmark every reader left in that book.
      //
      // Nothing in `npm test` can see this — the suite never touches a real
      // schema — and the loss leaves no error behind to find afterwards. So it
      // is asserted here, against the catalogue, where it is cheap and certain.
      const fk = await pool.query(
        `SELECT rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
         JOIN information_schema.referential_constraints rc
           ON rc.constraint_name = tc.constraint_name
         WHERE tc.table_name = 'bookmarks'
           AND tc.constraint_type = 'FOREIGN KEY'
           AND kcu.column_name = 'chunk_id'`
      );
      const rule = fk.rows[0]?.delete_rule;
      if (!rule) throw new Error("bookmarks.chunk_id has no foreign key — migration 026 is half-applied");
      if (rule !== "SET NULL") {
        throw new Error(
          `bookmarks.chunk_id deletes with ${rule}, not SET NULL — re-processing a book would ` +
          `destroy every bookmark in it. See migration 026.`
        );
      }
      return "range columns present, chunk_id is SET NULL";
    },
  },
  {
    name: "a chunk's span still matches its text (the line model rests on this)",
    run: async () => {
      // The reader cuts a chunk into lines and gives each an ABSOLUTE range,
      // computed as char_start + an offset into `content`. That arithmetic is
      // only correct while `char_end - char_start` equals the length of the
      // content it describes.
      //
      // Nothing enforces that. It is a property of how writeChunks stores what
      // chunkTextByParagraph produced, and a future change to either — a second
      // cleaning pass, a trim, a different join — would break it silently. What
      // the reader would then show is every highlight and every jump displaced
      // by a growing number of characters, with no error anywhere.
      //
      // ── Two queries, because of the unit and because of the weight ──────
      //
      // The offsets are produced by String.prototype.slice, so their unit is the
      // UTF-16 CODE UNIT. Postgres `length()` counts CODE POINTS. The two agree
      // for Hebrew and for Latin and disagree by one for every character outside
      // the Basic Multilingual Plane — an emoji, which uploads in this archive
      // do contain. Written as `char_end - char_start <> length(content)` alone,
      // this check reported two perfectly correct chunks as broken.
      //
      // So SQL narrows and JavaScript decides. The first query returns numbers
      // only — pulling every chunk's text across the wire took nine seconds and
      // then timed out, for an answer that is almost always "none". The second
      // fetches text for the few that look off, and settles them in the unit
      // that actually governs.
      const { rows: candidates } = await pool.query(
        `SELECT c.id
           FROM transcript_chunks c
           JOIN media_items m ON m.id = c.media_id
          WHERE m.media_type = 'text'
            AND c.char_start IS NOT NULL
            AND c.char_end - c.char_start <> length(c.content)`
      );
      const { rows: [{ n: total }] } = await pool.query(
        `SELECT count(*)::int AS n FROM transcript_chunks c
           JOIN media_items m ON m.id = c.media_id
          WHERE m.media_type = 'text' AND c.char_start IS NOT NULL`
      );
      if (candidates.length === 0) return `${total} book chunk(s), every span exact`;

      const { rows: suspect } = await pool.query(
        `SELECT id, char_start, char_end, content FROM transcript_chunks WHERE id = ANY($1)`,
        [candidates.map((c) => c.id)]
      );
      const wrong = suspect.filter((c) => c.char_end - c.char_start !== c.content.length);
      if (wrong.length > 0) {
        throw new Error(
          `${wrong.length} chunk(s) whose span does not match their text (e.g. ${wrong[0].id}) — ` +
          `every line offset in the reader is displaced for those books. See utilities/lines.js.`
        );
      }
      return `${total} book chunk(s), every span exact (${suspect.length} hold characters beyond the BMP)`;
    },
  },
  {
    name: "a bookmark can be placed on a page of the original (migration 027)",
    run: async () => {
      // The third anchor kind, against the real constraints. `npm test` stubs
      // the pool, so nothing in it has ever asked Postgres whether a row with a
      // page and a rectangle and NEITHER of the other two anchors is allowed —
      // and 022's constraint, as written, said no. If 027 did not replace it,
      // every mark made in the "מקור" tab is refused by the database.
      //
      // Inside a transaction that is always rolled back.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: [user] } = await client.query("SELECT id FROM users LIMIT 1");
        const { rows: [book] } = await client.query(
          "SELECT id FROM media_items WHERE media_type='text' LIMIT 1"
        );
        if (!user || !book) return "no book to place a mark in";

        await client.query(
          `INSERT INTO bookmarks (user_id, media_id, page_number, rect_x, rect_y, rect_w, rect_h, quoted_text)
           VALUES ($1, $2, 9, 0.12, 0.4315, 0.63, 0.021, 'smoke')`,
          [user.id, book.id]
        );

        // And the half that keeps a mark findable: three sides describe nothing.
        let partial = false;
        try {
          await client.query(
            `INSERT INTO bookmarks (user_id, media_id, page_number, rect_x, rect_y, rect_w)
             VALUES ($1, $2, 9, 0.1, 0.2, 0.3)`,
            [user.id, book.id]
          );
        } catch (err) {
          partial = err.code === "23514"; // check_violation
        }
        if (!partial) throw new Error("a rectangle missing a side was accepted — bookmarks_rect_is_whole is not enforcing");

        return "page + rectangle accepted, a partial rectangle refused";
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    },
  },
  {
    name: "re-processing a book keeps its bookmarks (migration 026)",
    run: async () => {
      // The consequence, as opposed to the catalogue entry above.
      //
      // The check before this one reads what Postgres SAYS the delete rule is.
      // This does what the pipeline does — writeChunks deletes every chunk of a
      // media item on every run — and looks at what is left. The two fail
      // together and say different things: that one names the cause, this one
      // names the loss, and the loss is every bookmark every reader left in a
      // sefer, gone on one press of "הפק סיכום מחדש" with no error behind it.
      //
      // Inside a transaction that is ALWAYS rolled back, so no real chunk is
      // harmed and no bookmark is created. That is what makes a write safe to
      // run here — and this is the only check in the file that writes at all.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: [user] } = await client.query("SELECT id FROM users LIMIT 1");
        const { rows: [chunk] } = await client.query(
          `SELECT c.id, c.media_id FROM transcript_chunks c
             JOIN media_items m ON m.id = c.media_id
            WHERE m.media_type='text' AND c.char_start IS NOT NULL
            ORDER BY c.id LIMIT 1`
        );
        if (!user || !chunk) return "no processed book to test against";

        const { rows: [bookmark] } = await client.query(
          `INSERT INTO bookmarks (user_id, media_id, char_position, char_end, chunk_id, quoted_text, page_number)
           VALUES ($1, $2, 0, 20, $3, 'smoke', 47) RETURNING id`,
          [user.id, chunk.media_id, chunk.id]
        );

        await client.query("DELETE FROM transcript_chunks WHERE media_id=$1", [chunk.media_id]);

        const { rows } = await client.query("SELECT chunk_id, quoted_text, page_number FROM bookmarks WHERE id=$1", [bookmark.id]);
        if (rows.length === 0) {
          throw new Error(
            "re-processing a book DELETED its bookmarks — chunk_id must be ON DELETE SET NULL, see migration 026"
          );
        }
        if (rows[0].chunk_id !== null) {
          throw new Error("the chunk was deleted but chunk_id did not become NULL — the reader cannot tell the anchor is stale");
        }
        if (rows[0].quoted_text !== "smoke" || rows[0].page_number !== 47) {
          throw new Error("the bookmark survived but lost what it was made from");
        }
        return "bookmark survives, anchor goes NULL, words and page kept";
      } finally {
        // Unconditional: the point of the transaction.
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    },
  },
  {
    name: "a mark on a page survives the round trip through the service",
    run: async () => {
      // The check above asks POSTGRES whether the row is legal. This asks the
      // code the client actually reaches: createBookmark's own validation, the
      // INSERT's column list, and the SELECT that reads it back. Those are three
      // separate places a column can be forgotten, and a forgotten one does not
      // raise — the mark is stored without its rectangle and comes back as a
      // bookmark pointing at a page with no place on it.
      //
      // Not in a transaction, because services take the pool rather than a
      // client. So it writes for real and removes what it wrote; a crash in
      // between leaves one bookmark quoted 'smoke' behind, which is why the
      // quote says that.
      const { rows: [user] } = await pool.query("SELECT id FROM users LIMIT 1");
      const { rows: [book] } = await pool.query(
        "SELECT id FROM media_items WHERE media_type='text' LIMIT 1"
      );
      if (!user || !book) return "no book to place a mark in";

      const rect = { x: 0.12, y: 0.4315, w: 0.63, h: 0.021 };
      let created = null;
      try {
        created = await createBookmark({
          userId: user.id,
          mediaId: book.id,
          pageNumber: 9,
          rect,
          quotedText: "smoke",
          note: "smoke",
        });

        // Written as a page anchor and nothing else. A timestamp defaulted to 0
        // here would label it "0:00" everywhere it is shown.
        if (created.timestamp_seconds !== null || created.char_position !== null) {
          throw new Error("a page mark came back carrying another kind's anchor");
        }
        if (!created.media_title) {
          throw new Error("the created row is missing its media title — the WITH_MEDIA CTE is not being used");
        }

        const listed = (await getBookmarksByUser(user.id, book.id))
          .find((b) => b.id === created.id);
        if (!listed) throw new Error("the mark was stored but the list does not return it");

        // REAL columns come back from pg as strings on some drivers and numbers
        // on others; what matters is that the four sides survive the trip and
        // still describe the rectangle that was drawn.
        const back = {
          x: Number(listed.rect_x), y: Number(listed.rect_y),
          w: Number(listed.rect_w), h: Number(listed.rect_h),
        };
        for (const side of ["x", "y", "w", "h"]) {
          if (Math.abs(back[side] - rect[side]) > 1e-5) {
            throw new Error(`rect_${side} came back as ${back[side]}, not ${rect[side]}`);
          }
        }
        if (listed.page_number !== 9) throw new Error(`page came back as ${listed.page_number}`);

        return `stored on page ${listed.page_number} at ${back.x}, ${back.y} and read back exact`;
      } finally {
        if (created) await deleteBookmark(created.id, user.id).catch(() => {});
      }
    },
  },
  {
    name: "a saved list comes back with its lectures (LATERAL join)",
    run: async () => {
      // The suite asserts on the SQL as TEXT — it checks that the words are
      // there, which is all a stubbed pool can check. It would pass just as
      // happily on SQL Postgres refuses to parse, and this query is the first
      // LATERAL join in the codebase.
      //
      // Read-only: it selects, and the row it selects belongs to whoever is
      // first in the users table.
      const { rows: [user] } = await pool.query("SELECT id FROM users LIMIT 1");
      if (!user) return "no user to read lists for";

      const scope = { courses: null, drafts: null };
      const lists = await getPlaylists(user.id, { withItems: true, scope });

      if (!Array.isArray(lists)) throw new Error("the query did not return rows");
      if (lists.length === 0) return "the query runs; this user owns no lists";

      // json_agg over no rows is NULL, and a page that maps over null crashes.
      // COALESCE is what makes an empty list an empty list.
      for (const list of lists) {
        if (!Array.isArray(list.items)) {
          throw new Error(`list ${list.id} came back with items as ${typeof list.items}, not an array`);
        }
        if (list.items.length > ITEMS_PER_LIST) {
          throw new Error(`list ${list.id} returned ${list.items.length} items, past the cap of ${ITEMS_PER_LIST}`);
        }
        // Newest first, which is the order the page reads them in.
        const dates = list.items.map((i) => new Date(i.added_at).getTime());
        if (dates.some((d, i) => i > 0 && d > dates[i - 1])) {
          throw new Error(`list ${list.id} came back out of order`);
        }
      }

      const withItems = lists.filter((l) => l.items.length > 0).length;
      return `${lists.length} list(s), ${withItems} holding lectures, none past the cap`;
    },
  },
  {
    name: "a proposed tag waits, and approval files it and tags the item (migration 029)",
    run: async () => {
      // `npm test` stubs the pool, so it has never asked Postgres whether the
      // ON CONFLICT in proposeTag names an index that exists — a partial index
      // is inferred only when the WHERE matches it, and a mismatch fails at
      // runtime, on the first proposal anybody makes.
      //
      // The service functions open their own transactions, so they run on ONE
      // real client inside an outer transaction that is always rolled back:
      // their BEGIN/COMMIT/ROLLBACK become savepoints, and pool.query is routed
      // to the same client so reads see the uncommitted rows. Nothing survives.
      const client = await pool.connect();
      const original = { query: pool.query, connect: pool.connect };
      const inner = {
        query: (text, params) => {
          if (text === "BEGIN") return client.query("SAVEPOINT smoke_tx");
          if (text === "COMMIT") return client.query("RELEASE SAVEPOINT smoke_tx");
          if (text === "ROLLBACK") return client.query("ROLLBACK TO SAVEPOINT smoke_tx");
          return client.query(text, params);
        },
        release: () => {},
      };
      try {
        await client.query("BEGIN");
        const { rows: [user] } = await client.query("SELECT id FROM users LIMIT 1");
        const { rows: [item] } = await client.query("SELECT id FROM media_items ORDER BY id LIMIT 1");
        const { rows: [parent] } = await client.query("SELECT id FROM tags ORDER BY id LIMIT 1");
        if (!user || !item || !parent) return "no user, item or tag to propose against";

        // @ts-ignore — a stand-in for the duration of this check only
        pool.query = inner.query;
        // @ts-ignore
        pool.connect = async () => inner;

        const lecturer = { id: user.id, role: "lecturer" };
        const name = `__smoke ${Date.now()}`;

        const first = await proposeTag({ mediaId: item.id, name, parentId: parent.id, user: lecturer });
        const again = await proposeTag({ mediaId: item.id, name: name.toUpperCase(), parentId: parent.id, user: lecturer });
        if (again.id !== first.id) throw new Error("the same name in the same place became two proposals — the pending unique index is not matching");

        const forItem = await getPendingProposalsForMedia(item.id);
        if (!forItem.some((p) => p.id === first.id)) throw new Error("the item does not list its own pending proposal");
        const queue = await getPendingProposals();
        const queued = queue.find((p) => p.id === first.id);
        if (!queued || !Array.isArray(queued.media) || !queued.media.some((m) => m.id === item.id)) {
          throw new Error("the admin queue is missing the proposal or the item waiting on it");
        }

        const approved = await approveTagProposal(first.id, user.id);
        const { rows: tagged } = await client.query(
          `SELECT 1 FROM tags t JOIN media_tags mt ON mt.tag_id = t.id
            WHERE t.id = $1 AND t.parent_id = $2 AND mt.media_id = $3`,
          [approved.tag_id, parent.id, item.id]
        );
        if (tagged.length === 0) throw new Error("approval did not put the tag under its parent and on the item");

        let exists = false;
        try {
          await proposeTag({ mediaId: item.id, name, parentId: parent.id, user: lecturer });
        } catch (err) {
          exists = err.code === "TAG_EXISTS";
        }
        if (!exists) throw new Error("proposing a tag that now exists was not refused with TAG_EXISTS");

        const second = await proposeTag({ mediaId: item.id, name: `${name} b`, parentId: null, user: lecturer });
        await rejectTagProposal(second.id, user.id, "smoke");
        const third = await proposeTag({ mediaId: item.id, name: `${name} c`, parentId: null, user: lecturer });
        await withdrawProposal(item.id, third.id);
        const { rows: [left] } = await client.query("SELECT COUNT(*)::int AS n FROM tag_proposals WHERE id = $1", [third.id]);
        if (left.n !== 0) throw new Error("a withdrawn proposal nobody waits on was left for an admin to decide");

        return "proposed, merged, queued, approved onto the item, then refused as existing; reject and withdraw work";
      } finally {
        pool.query = original.query;
        pool.connect = original.connect;
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
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
