import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { getAllMedia, getMediaPage, countMedia } from "../services/servicesMedia.js";

// The archive's statement, exactly as it is sent: the SQL text and its
// parameters, for every filter alone, the edge values each one treats as "no
// filter", every sort order, and everything at once — through all three
// readers (the list, a page, the count).
//
// A characterization test. The expected statements are a recording of what the
// builder produced when this file was written, kept beside it in
// fixtures/mediaFilterSql.golden.json, so a change to how the WHERE clause is
// put together can be checked against the statement it replaces, byte for byte.
// A change MEANT to alter the SQL re-records it:
//
//   UPDATE_GOLDEN=1 node --test test/mediaFilterSql.test.js
//
// and the diff of the golden file is then the change to review.

const GOLDEN_FILE = new URL("./fixtures/mediaFilterSql.golden.json", import.meta.url);

const ADMIN = { courses: null, drafts: null };
const STUDENT = { courses: [5, 8], drafts: [] };
const LECTURER = { courses: null, drafts: [10] };

const EVERYTHING = {
  types: ["video", "audio"],
  courseId: 3,
  published: true,
  creator: "הרב כהן",
  search: "100%_\\",
  tagIds: [3, 9],
  excludeTagIds: [5, 7],
  uploadedAfter: "2026-01-06",
  uploadedBefore: "2026-03-31",
  minDuration: 900,
  maxDuration: 3600,
  sort: "liked",
};

const CASES = {
  "no scope, no filters": () => getAllMedia(undefined),
  "admin scope": () => getAllMedia(ADMIN),
  "student scope": () => getAllMedia(STUDENT),
  "lecturer scope": () => getAllMedia(LECTURER),
  "types: two": () => getAllMedia(ADMIN, { types: ["video", "audio"] }),
  "types: empty is no filter": () => getAllMedia(ADMIN, { types: [] }),
  "course": () => getAllMedia(ADMIN, { courseId: 3 }),
  "course: null is still a condition": () => getAllMedia(ADMIN, { courseId: null }),
  "published: false": () => getAllMedia(ADMIN, { published: false }),
  "creator": () => getAllMedia(ADMIN, { creator: "הרב כהן" }),
  "creator: empty is no filter": () => getAllMedia(ADMIN, { creator: "" }),
  "search, with LIKE wildcards to escape": () => getAllMedia(ADMIN, { search: "100%_\\" }),
  "search: empty is no filter": () => getAllMedia(ADMIN, { search: "" }),
  "tags": () => getAllMedia(ADMIN, { tagIds: [3, 9] }),
  "tags: empty is no filter": () => getAllMedia(ADMIN, { tagIds: [] }),
  "excluded tags": () => getAllMedia(ADMIN, { excludeTagIds: [5] }),
  "excluded tags: empty is no filter": () => getAllMedia(ADMIN, { excludeTagIds: [] }),
  "tags and excluded tags": () => getAllMedia(ADMIN, { tagIds: [2], excludeTagIds: [5] }),
  "uploaded after": () => getAllMedia(ADMIN, { uploadedAfter: "2026-01-06" }),
  "uploaded before": () => getAllMedia(ADMIN, { uploadedBefore: "2026-01-31" }),
  "uploaded between": () => getAllMedia(ADMIN, { uploadedAfter: "2026-01-06", uploadedBefore: "2026-01-31" }),
  "length: at least": () => getAllMedia(ADMIN, { minDuration: 1800 }),
  "length: under": () => getAllMedia(ADMIN, { maxDuration: 900 }),
  "length: between": () => getAllMedia(ADMIN, { minDuration: 900, maxDuration: 1800 }),
  "length: a non-integer end is no filter": () => getAllMedia(ADMIN, { minDuration: 1.5, maxDuration: "900" }),
  "sort: newest": () => getAllMedia(ADMIN, { sort: "newest" }),
  "sort: oldest": () => getAllMedia(ADMIN, { sort: "oldest" }),
  "sort: title": () => getAllMedia(ADMIN, { sort: "title" }),
  "sort: creator": () => getAllMedia(ADMIN, { sort: "creator" }),
  "sort: liked": () => getAllMedia(ADMIN, { sort: "liked" }),
  "sort: unknown falls back": () => getAllMedia(ADMIN, { sort: "random" }),
  "everything, as a student": () => getAllMedia(STUDENT, EVERYTHING),
  "a page of everything": () => getMediaPage(LECTURER, EVERYTHING, { limit: 24, offset: 48 }),
  "the count of everything": () => countMedia(STUDENT, EVERYTHING),
};

const capture = async (run) => {
  const db = stubPoolQuery(pool, () => ({ rows: [{ count: 0 }] }));
  try {
    await run();
    assert.equal(db.calls.length, 1, "one statement");
    return { sql: db.calls[0].text, params: db.calls[0].params };
  } finally {
    db.restore();
  }
};

if (process.env.UPDATE_GOLDEN) {
  const recorded = {};
  for (const [name, run] of Object.entries(CASES)) recorded[name] = await capture(run);
  writeFileSync(GOLDEN_FILE, `${JSON.stringify(recorded, null, 2)}\n`);
}

const golden = JSON.parse(readFileSync(GOLDEN_FILE, "utf8"));

test("the recording holds exactly these cases", () => {
  assert.deepEqual(Object.keys(golden).sort(), Object.keys(CASES).sort());
});

for (const [name, run] of Object.entries(CASES)) {
  test(`the statement for: ${name}`, async () => {
    assert.deepEqual(await capture(run), golden[name]);
  });
}
