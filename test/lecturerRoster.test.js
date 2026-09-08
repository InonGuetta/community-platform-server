import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// A lecturer managing the roster of the courses they teach — and only those.
//
// This opens two write paths that were admin-only, so the risk it carries is
// precisely that opening the ROLE gate is mistaken for opening the whole door.
// requireRole says a lecturer may enrol somebody somewhere. It cannot say WHICH
// course, because it runs before the course row is loaded. Every test below that
// expects a 403 is testing the second layer, not the first.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

const OWNER = { id: 10, email: "owner@example.com", role: "lecturer", is_active: true };
const OTHER = { id: 11, email: "other@example.com", role: "lecturer", is_active: true };
const ADMIN = { id: 12, email: "admin@example.com", role: "admin", is_active: true };
const STUDENT = { id: 13, email: "student@example.com", role: "student", is_active: true };

const tokenFor = (u) =>
  jwt.sign({ id: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET, { expiresIn: "1h" });

// Course 4 is taught by OWNER.
const COURSE = { id: 4, title: "קורס", lecturer_id: OWNER.id, is_active: true };

const asCaller = (user, extra = () => null) =>
  stubPoolQuery(pool, (text, params) => {
    const custom = extra(text, params);
    if (custom) return custom;
    if (/FROM courses/i.test(text)) return { rows: [COURSE] };
    if (/FROM users/i.test(text)) return { rows: [user] };
    if (/INSERT INTO enrollments/i.test(text)) return { rows: [{ id: 1 }] };
    if (/DELETE FROM enrollments/i.test(text)) return { rows: [{ id: 1 }] };
    return { rows: [] };
  });

const enrol = (user) =>
  request(app)
    .post("/api/courses/4/students")
    .set("Cookie", `token=${tokenFor(user)}`)
    .send({ studentId: STUDENT.id });

const unenrol = (user) =>
  request(app).delete("/api/courses/4/students/13").set("Cookie", `token=${tokenFor(user)}`);

// ── Enrolling ───────────────────────────────────────────────────────────────

test("the lecturer who teaches the course may enrol into it", async () => {
  asCaller(OWNER);
  const res = await enrol(OWNER);
  assert.equal(res.status, 201, `answered ${res.status}; the owner must be able to run their roster`);
});

test("an admin may still enrol into any course", async () => {
  asCaller(ADMIN);
  const res = await enrol(ADMIN);
  assert.equal(res.status, 201, "opening this to lecturers must not close it to admins");
});

// The reason this file exists.
test("a lecturer may NOT enrol into a course they do not teach", async () => {
  asCaller(OTHER);
  const res = await enrol(OTHER);
  assert.equal(res.status, 403, `answered ${res.status}; requireRole alone is not enough`);
});

test("a student may not enrol anybody", async () => {
  asCaller(STUDENT);
  const res = await enrol(STUDENT);
  assert.equal(res.status, 403, "requireRole is still the first layer");
});

// ── Removing ────────────────────────────────────────────────────────────────

test("the owner may remove a student", async () => {
  asCaller(OWNER);
  const res = await unenrol(OWNER);
  assert.equal(res.status, 200);
});

test("a lecturer may NOT remove from somebody else's course", async () => {
  asCaller(OTHER);
  const res = await unenrol(OTHER);
  assert.equal(res.status, 403);
});

// ── Searching for somebody to add ───────────────────────────────────────────

const search = (user, q) =>
  request(app)
    .get(`/api/courses/4/enrollable-students${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`)
    .set("Cookie", `token=${tokenFor(user)}`);

test("the search is gated on owning the course, not merely on being a lecturer", async () => {
  asCaller(OTHER);
  const res = await search(OTHER, "כהן");
  assert.equal(
    res.status,
    403,
    "otherwise every approved lecturer holds a search over the whole membership"
  );
});

// The privacy design: a one-character query cannot be walked, so there is no
// first page to page through.
test("a query shorter than two characters returns nothing at all", async () => {
  let reachedUserSearch = false;
  asCaller(OWNER, (text) => {
    if (/ILIKE/i.test(text)) reachedUserSearch = true;
    return null;
  });
  for (const q of ["", "א", undefined]) {
    const res = await search(OWNER, q);
    assert.equal(res.status, 200, "a short query is an empty answer, not an error");
    assert.deepEqual(res.body, []);
  }
  assert.equal(reachedUserSearch, false, "and it must not even reach the database");
});

test("a real query is capped and excludes people already enrolled", async () => {
  let searchSql = "";
  let searchParams = [];
  asCaller(OWNER, (text, params) => {
    if (/ILIKE/i.test(text)) {
      searchSql = text;
      searchParams = params;
      return { rows: [{ id: 99, email: "a@example.com", display_name: "כהן", role: "student" }] };
    }
    return null;
  });

  const res = await search(OWNER, "כהן");
  assert.equal(res.status, 200);
  assert.match(searchSql, /LIMIT/i, "the result set is capped");
  assert.match(searchSql, /NOT EXISTS/i, "already-enrolled people are excluded");
  assert.match(searchSql, /is_active/i, "deactivated accounts are excluded");
  assert.ok(searchParams.includes(20), "the cap is 20");
});

// Deliberately NOT filtered to role='student'. Enrolling a lecturer in a
// colleague's course is documented as intended in the client's App.jsx and
// Navbar.jsx, and filtering here would remove it silently.
test("the search does not filter by role", async () => {
  let searchSql = "";
  asCaller(OWNER, (text) => {
    if (/ILIKE/i.test(text)) {
      searchSql = text;
      return { rows: [] };
    }
    return null;
  });
  await search(OWNER, "כהן");
  assert.doesNotMatch(
    searchSql,
    /role\s*=\s*'student'/i,
    "a lecturer may be enrolled in a colleague's course — see App.jsx"
  );
});

// ── The lecturer's own students ─────────────────────────────────────────────

test("my-students answers for the caller and takes no id to point elsewhere", async () => {
  let params = [];
  asCaller(OWNER, (text, p) => {
    if (/json_agg/i.test(text)) {
      params = p;
      return { rows: [{ id: 99, display_name: "תלמיד", course_count: 2, courses: [] }] };
    }
    return null;
  });

  const res = await request(app)
    .get("/api/courses/my-students")
    .set("Cookie", `token=${tokenFor(OWNER)}`);

  assert.equal(res.status, 200);
  assert.deepEqual(params, [OWNER.id], "scoped to the caller, with no way to name somebody else");
});

// A student in three of this lecturer's courses is one student, not three rows.
test("my-students groups a student who is in several courses into one row", async () => {
  asCaller(OWNER, (text) =>
    /json_agg/i.test(text) ? { rows: [{ id: 99, course_count: 3, courses: [{}, {}, {}] }] } : null
  );
  const res = await request(app)
    .get("/api/courses/my-students")
    .set("Cookie", `token=${tokenFor(OWNER)}`);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].course_count, 3);
});

test("a student cannot ask who a lecturer teaches", async () => {
  asCaller(STUDENT);
  const res = await request(app)
    .get("/api/courses/my-students")
    .set("Cookie", `token=${tokenFor(STUDENT)}`);
  assert.equal(res.status, 403);
});

// "/my-students" is declared before "/:id"; the other order makes
// validateIntParam reject the literal word and the route unreachable.
test("my-students is not swallowed by the /:id route", async () => {
  asCaller(OWNER, (text) => (/json_agg/i.test(text) ? { rows: [] } : null));
  const res = await request(app)
    .get("/api/courses/my-students")
    .set("Cookie", `token=${tokenFor(OWNER)}`);
  assert.equal(res.status, 200, "a 400 here means the route order regressed");
});
