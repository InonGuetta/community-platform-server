import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { viewerScopeFor, canUserSeeMedia } from "../services/servicesVisibility.js";
import { UNRESTRICTED } from "../lib/permissions.js";

// What each role is actually GIVEN — as opposed to what the rule does with it.
//
// This file exists because of a gap the rule's own tests could not close.
// mediaVisibility.test.js drives canSeeMediaRow with explicit arguments, so it
// proves the rule is right for any input; it says nothing about which input each
// role receives. Reverting viewerScopeFor to hand a lecturer every draft on the
// platform left that whole suite green.
//
// The rule from CLAUDE.md: a green suite that does not execute the lines you
// changed is not evidence. These are the lines.

const enrolledIn = (courseIds) =>
  stubPoolQuery(pool, (text) => {
    if (/FROM enrollments/i.test(text)) return { rows: courseIds.map((id) => ({ course_id: id })) };
    return { rows: [] };
  });

// ── Who gets what ───────────────────────────────────────────────────────────

test("an admin is unrestricted on both dimensions", async () => {
  const scope = await viewerScopeFor({ id: 1, role: "admin" });
  assert.equal(scope.courses, UNRESTRICTED);
  assert.equal(scope.drafts, UNRESTRICTED);
});

// The change this file is here to protect. A lecturer keeps the whole published
// archive — courses unrestricted — and is narrowed to their OWN drafts.
test("a lecturer gets every published lesson, and only their own drafts", async () => {
  const scope = await viewerScopeFor({ id: 10, role: "lecturer" });
  assert.equal(scope.courses, UNRESTRICTED, "narrowing drafts must not narrow the archive");
  assert.deepEqual(scope.drafts, [10], "their own id, and nobody else's");
  assert.notEqual(scope.drafts, UNRESTRICTED, "a lecturer is NOT unrestricted on drafts");
});

test("a student is restricted on both", async () => {
  const db = enrolledIn([5, 8]);
  try {
    const scope = await viewerScopeFor({ id: 7, role: "student" });
    assert.deepEqual(scope.courses, [5, 8]);
    assert.deepEqual(scope.drafts, [], "nobody's drafts — and [] is not null");
  } finally {
    db.restore();
  }
});

// [] and null are different answers on both dimensions. Conflating them is how a
// student silently becomes unrestricted, or a lecturer silently loses the
// archive.
test("a student in no course gets an empty array, not null", async () => {
  const db = enrolledIn([]);
  try {
    const scope = await viewerScopeFor({ id: 7, role: "student" });
    assert.deepEqual(scope.courses, []);
    assert.notEqual(scope.courses, UNRESTRICTED);
  } finally {
    db.restore();
  }
});

// A lecturer and an admin cost no enrolment lookup — the busiest read in the
// application resolves their scope without touching the database.
test("only a student pays for a query", async () => {
  const db = enrolledIn([]);
  try {
    await viewerScopeFor({ id: 1, role: "admin" });
    await viewerScopeFor({ id: 10, role: "lecturer" });
    assert.equal(db.calls.length, 0, "neither role should have queried");
    await viewerScopeFor({ id: 7, role: "student" });
    assert.equal(db.calls.length, 1);
  } finally {
    db.restore();
  }
});

// ── The single-item check has to agree with the list ────────────────────────
//
// canUserSeeMedia settles a row already in hand and shortcuts before the
// enrolment lookup where it can. Those shortcuts are a second copy of the rule,
// so they are checked against the same cases.

const draftBy = (uploaderId) => ({ is_published: false, course_id: null, uploader_id: uploaderId });

test("a lecturer may open their own draft", async () => {
  assert.equal(await canUserSeeMedia({ id: 10, role: "lecturer" }, draftBy(10)), true);
});

test("a lecturer may NOT open a colleague's draft", async () => {
  assert.equal(
    await canUserSeeMedia({ id: 10, role: "lecturer" }, draftBy(11)),
    false,
    "the single-item check must agree with the listing"
  );
});

test("an admin may open anybody's draft", async () => {
  assert.equal(await canUserSeeMedia({ id: 1, role: "admin" }, draftBy(11)), true);
});

test("a lecturer may open a published lesson in a course they are not in", async () => {
  const published = { is_published: true, course_id: 5, uploader_id: 11 };
  assert.equal(await canUserSeeMedia({ id: 10, role: "lecturer" }, published), true);
});

test("a student may not open a draft, whoever uploaded it", async () => {
  const db = enrolledIn([5]);
  try {
    assert.equal(await canUserSeeMedia({ id: 7, role: "student" }, draftBy(7)), false);
    assert.equal(await canUserSeeMedia({ id: 7, role: "student" }, draftBy(11)), false);
  } finally {
    db.restore();
  }
});
