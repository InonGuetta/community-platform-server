import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { compareSnapshots } from "../scripts/backupStatus.js";

// The restore drill's verdict (PRD NFR-2): what a restored database lacks
// against the snapshot taken before the backup.

const snap = (counts, schema = { "049": true, "048": true }) => ({ takenAt: "t", database: { counts, schema } });

test("a restore with everything — or more, since the live database kept going — passes", () => {
  assert.deepEqual(compareSnapshots(snap({ users: 10, notes: 7 }), snap({ users: 10, notes: 9 })), []);
});

test("a restore that lost rows, a table, or the newest schema fails, and says which", () => {
  const problems = compareSnapshots(
    snap({ users: 10, notes: 7, bookmarks: 26 }),
    snap({ users: 10, notes: 3, bookmarks: null }, { "049": false, "048": true })
  );
  assert.deepEqual(problems, [
    "notes: 3 rows, had 7",
    "bookmarks: missing (had 26 rows)",
    "schema: migration 049's table is missing",
  ]);
});

test("a table the snapshot did not have is not held against the restore", () => {
  assert.deepEqual(compareSnapshots(snap({ donations: null }), snap({ donations: null })), []);
});
