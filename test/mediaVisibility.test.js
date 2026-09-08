import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { getAllMedia } from "../services/servicesMedia.js";
import { canSeeMediaRow, visibleMediaSql, UNRESTRICTED } from "../lib/permissions.js";
import { visibleCoursesFor, canUserSeeMedia } from "../services/servicesVisibility.js";

// The rule that decides what anybody is shown. It has two dimensions now — is it
// published, and is this lesson in a course you are in — and it is stated once.

const STUDENT = { id: 1, role: "student" };
const LECTURER = { id: 2, role: "lecturer" };
const ADMIN = { id: 3, role: "admin" };

const GENERAL = { is_published: true, course_id: null };
const IN_COURSE_5 = { is_published: true, course_id: 5 };
const DRAFT = { is_published: false, course_id: null };

// ── The rule itself ─────────────────────────────────────────────────────────

test("an unrestricted view sees everything", () => {
  for (const item of [GENERAL, IN_COURSE_5, DRAFT]) {
    // Both dimensions unrestricted — which is what an admin gets.
    assert.equal(canSeeMediaRow(item, UNRESTRICTED, UNRESTRICTED), true);
  }
});

// ── Whose drafts ────────────────────────────────────────────────────────────
//
// The second dimension, and the reason it exists: a lecturer used to be
// "unrestricted" on the only dimension there was, which meant every draft on the
// platform — including a colleague's unpublished work in progress.

const MY_DRAFT = { is_published: false, course_id: null, uploader_id: 10 };
const THEIR_DRAFT = { is_published: false, course_id: null, uploader_id: 11 };

test("a lecturer sees their own draft and not a colleague's", () => {
  assert.equal(canSeeMediaRow(MY_DRAFT, UNRESTRICTED, [10]), true);
  assert.equal(canSeeMediaRow(THEIR_DRAFT, UNRESTRICTED, [10]), false);
});

// The regression that would hurt most: narrowing drafts must not narrow the
// published archive. A lecturer keeps every published lesson, in every course,
// including courses they are not enrolled in.
test("a lecturer still sees every published lesson, in any course", () => {
  assert.equal(canSeeMediaRow(GENERAL, UNRESTRICTED, [10]), true);
  assert.equal(canSeeMediaRow(IN_COURSE_5, UNRESTRICTED, [10]), true);
});

test("a student sees nobody's drafts, including their own uploads", () => {
  assert.equal(canSeeMediaRow(MY_DRAFT, [], []), false);
  assert.equal(canSeeMediaRow(DRAFT, [5], []), false);
});

// [] and null are different answers and must never be conflated: one is "nobody",
// the other is "everybody".
test("an empty drafts list is nobody, not everybody", () => {
  assert.equal(canSeeMediaRow(THEIR_DRAFT, UNRESTRICTED, []), false);
  assert.equal(canSeeMediaRow(THEIR_DRAFT, UNRESTRICTED, UNRESTRICTED), true);
});

test("failing closed is still the default", () => {
  assert.equal(canSeeMediaRow(DRAFT), false);
  assert.equal(canSeeMediaRow(IN_COURSE_5), false);
});

// Not a concession — a necessity. course_id is null on every item uploaded
// before courses existed, which is most of the archive. Gating those on
// enrolment would have hidden the entire existing library from every student.
test("a lesson in no course is the general library and stays visible", () => {
  assert.equal(canSeeMediaRow(GENERAL, []), true);
});

test("a lesson in a course needs enrolment in that course", () => {
  assert.equal(canSeeMediaRow(IN_COURSE_5, []), false);
  assert.equal(canSeeMediaRow(IN_COURSE_5, [9]), false);
  assert.equal(canSeeMediaRow(IN_COURSE_5, [5]), true);
  assert.equal(canSeeMediaRow(IN_COURSE_5, [1, 5, 9]), true);
});

test("enrolment does not reveal a draft", () => {
  // Both dimensions apply. Being in the course is not a way to see what has not
  // been published yet.
  assert.equal(canSeeMediaRow({ is_published: false, course_id: 5 }, [5]), false);
});

test("an id that has been through JSON still matches", () => {
  // The same trap canManageMedia documents: a course id out of a route param or
  // a JSON round trip is a string, and a strict compare would lock out the
  // student who is genuinely enrolled.
  assert.equal(canSeeMediaRow({ is_published: true, course_id: "5" }, [5]), true);
  assert.equal(canSeeMediaRow(IN_COURSE_5, ["5"]), true);
});

// The default is the view of someone enrolled in nothing. Unrestricted has to be
// asked for, so a caller that forgets an argument shows too little, never too
// much.
test("the default fails closed", () => {
  assert.equal(canSeeMediaRow(IN_COURSE_5), false);
  assert.equal(canSeeMediaRow(DRAFT), false);
  assert.equal(canSeeMediaRow(GENERAL), true);
});

test("a missing row is never visible", () => {
  assert.equal(canSeeMediaRow(undefined, [1]), false);
  assert.equal(canSeeMediaRow({}, [1]), false);
});

// ── Resolving a user into that value ────────────────────────────────────────

test("a lecturer and an admin are unrestricted, and cost no query", async () => {
  const stub = stubPoolQuery(pool, () => {
    throw new Error("looked up enrolments for someone who does not need them");
  });
  try {
    assert.equal(await visibleCoursesFor(LECTURER), UNRESTRICTED);
    assert.equal(await visibleCoursesFor(ADMIN), UNRESTRICTED);
  } finally {
    stub.restore();
  }
});

test("a student resolves to the courses they are enrolled in", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [{ course_id: 5 }, { course_id: 8 }] }));
  try {
    assert.deepEqual(await visibleCoursesFor(STUDENT), [5, 8]);
  } finally {
    stub.restore();
  }
});

test("a student enrolled in nothing gets an empty list, not unrestricted", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    assert.deepEqual(await visibleCoursesFor(STUDENT), []);
  } finally {
    stub.restore();
  }
});

// Most of the archive has no course, so the common case must not pay for a
// lookup it cannot use.
test("a general-library item is decided without querying enrolments", async () => {
  const stub = stubPoolQuery(pool, () => {
    throw new Error("queried enrolments for an item that belongs to no course");
  });
  try {
    assert.equal(await canUserSeeMedia(STUDENT, GENERAL), true);
    assert.equal(await canUserSeeMedia(STUDENT, DRAFT), false, "a draft is settled without a query too");
  } finally {
    stub.restore();
  }
});

test("a course lesson is decided against the student's enrolments", async () => {
  const enrolled = stubPoolQuery(pool, () => ({ rows: [{ course_id: 5 }] }));
  try {
    assert.equal(await canUserSeeMedia(STUDENT, IN_COURSE_5), true);
  } finally {
    enrolled.restore();
  }

  const notEnrolled = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    assert.equal(await canUserSeeMedia(STUDENT, IN_COURSE_5), false);
  } finally {
    notEnrolled.restore();
  }
});

// ── The SQL form says the same thing ────────────────────────────────────────

test("the SQL form carries both dimensions and both casts", () => {
  const sql = visibleMediaSql("$2");
  assert.match(sql, /\$2::int\[\] IS NULL/, "null is how unrestricted is expressed");
  assert.match(sql, /m\.is_published/);
  assert.match(sql, /m\.course_id IS NULL/, "the general library must survive the filter");
  assert.match(sql, /m\.course_id = ANY\(\$2::int\[\]\)/);
});

test("the SQL form honours the alias it is given", () => {
  assert.match(visibleMediaSql("$3", "mi"), /mi\.is_published/);
});

// ── The listing applies it unconditionally ──────────────────────────────────

const runList = async (filters) => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    await getAllMedia(filters);
    return stub.calls[0];
  } finally {
    stub.restore();
  }
};

test("the visibility predicate is always in the WHERE clause", async () => {
  const bare = await runList({});
  assert.match(bare.text, /WHERE \(/);
  assert.match(bare.text, /\$1::int\[\] IS NULL/, "the courses dimension");
  assert.match(bare.text, /\$2::int\[\] IS NULL/, "and the drafts dimension");
  assert.deepEqual(bare.params[0], [], "absent means enrolled in nothing, never unrestricted");
  assert.deepEqual(bare.params[1], [], "and nobody's drafts, never everybody's");
});

test("an unrestricted caller passes null", async () => {
  const call = await runList({ visibleCourses: UNRESTRICTED });
  assert.equal(call.params[0], null);
});

test("a student's courses are passed as the array they are", async () => {
  const call = await runList({ visibleCourses: [5, 8] });
  assert.deepEqual(call.params[0], [5, 8]);
});

test("the caller's own published filter is separate from the rule", async () => {
  const call = await runList({ visibleCourses: UNRESTRICTED, visibleDrafts: UNRESTRICTED, published: false });
  // $1 and $2 are the two halves of the RULE; the caller's narrowing comes after.
  assert.match(call.text, /m\.is_published=\$3/);
  assert.deepEqual(call.params, [null, null, false], "the rule first, then the narrowing");
});

// ── A search phrase is a phrase, not a pattern ──────────────────────────────

test("wildcards in the search text are escaped", async () => {
  const call = await runList({ search: "100%" });
  assert.equal(call.params.at(-1), "%100\\%%", "the typed % must match a literal %");
});

test("an underscore is escaped too", async () => {
  const call = await runList({ search: "פרק_ב" });
  assert.equal(call.params.at(-1), "%פרק\\_ב%");
});

test("a backslash is escaped before it can escape something else", async () => {
  const call = await runList({ search: "a\\b" });
  assert.equal(call.params.at(-1), "%a\\\\b%");
});

test("ordinary text is left alone", async () => {
  const call = await runList({ search: "שיעור בגמרא" });
  assert.equal(call.params.at(-1), "%שיעור בגמרא%");
});
