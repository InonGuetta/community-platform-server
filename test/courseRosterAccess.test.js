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

// Reading a course's student list is an OWNERSHIP question, not merely a role
// question — and for a long time it was only checked as the latter.
//
// GET /courses/:id/students sat behind requireRole("lecturer","admin") and
// nothing else, while every other handler in that file loaded the course row and
// called assertCanManageCourse. The consequence was quiet and real: any lecturer
// could read the names and email addresses of every student in every course on
// the platform, including courses they have nothing to do with.
//
// requireRole cannot close this. It runs in the router, before the course row
// exists, so it has no idea WHICH course is being asked for. That is the reason
// this codebase asks two questions on every protected path, and this test exists
// to stop the second one being dropped again.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

const OWNER = { id: 10, email: "owner@example.com", role: "lecturer" };
const OTHER = { id: 11, email: "other@example.com", role: "lecturer" };
const ADMIN = { id: 12, email: "admin@example.com", role: "admin" };
const STUDENT = { id: 13, email: "student@example.com", role: "student" };

const tokenFor = (user) =>
  jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: "1h",
  });

// Course 4 is taught by OWNER and by nobody else.
const COURSE = { id: 4, title: "קורס", lecturer_id: OWNER.id, is_active: true };

const ROSTER = [{ id: 99, display_name: "תלמיד", email: "s@example.com" }];

// verifyToken reads the caller's row first; then the controller loads the course
// to decide ownership; then, if it got that far, the roster itself.
const asCaller = (user) =>
  stubPoolQuery(pool, (text) => {
    if (/FROM users/i.test(text)) return { rows: [user] };
    if (/FROM courses/i.test(text)) return { rows: [COURSE] };
    if (/FROM enrollments/i.test(text)) return { rows: ROSTER };
    return { rows: [] };
  });

const readRoster = async (user) => {
  const db = asCaller(user);
  try {
    return await request(app).get("/api/courses/4/students").set("Cookie", `token=${tokenFor(user)}`);
  } finally {
    db.restore?.();
  }
};

test("the lecturer who teaches the course may read its roster", async () => {
  const res = await readRoster(OWNER);
  assert.equal(res.status, 200, `answered ${res.status}; the owner must not be locked out`);
});

test("an admin may read any roster", async () => {
  const res = await readRoster(ADMIN);
  assert.equal(res.status, 200);
});

// The regression this file exists for.
test("a lecturer may NOT read the roster of a course they do not teach", async () => {
  const res = await readRoster(OTHER);
  assert.equal(
    res.status,
    403,
    `answered ${res.status}; a lecturer must not see the students of somebody else's course`
  );
});

// 403 and not 404: the catalogue is already readable by any signed-in user, so
// the course's existence is not a secret and pretending otherwise would only
// turn "not yours" into a confusing "gone".
test("the refusal names the reason rather than hiding the course", async () => {
  const res = await readRoster(OTHER);
  assert.equal(res.status, 403);
  assert.ok(res.body.code, "an AppError carries a stable code the client translates");
});

test("a student cannot reach the roster at all", async () => {
  const res = await readRoster(STUDENT);
  assert.equal(res.status, 403, "requireRole is the first of the two layers and still applies");
});
