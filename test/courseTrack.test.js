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
import { trackSummary, buildCourseReport } from "../services/servicesCourseTrack.js";
import { saveWatchProgress } from "../services/servicesMedia.js";

// A course as a track (PRD CRS-1, CRS-2, CRS-3, migration 043).

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();
const OWNER = { id: 10, email: "o@example.com", role: "lecturer", is_active: true };
const OTHER = { id: 11, email: "x@example.com", role: "lecturer", is_active: true };
const STUDENT = { id: 13, email: "s@example.com", role: "student", is_active: true };
const cookieFor = (u) => `token=${jwt.sign({ id: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;

const COURSE = { id: 4, title: "גמרא", lecturer_id: OWNER.id, lecturer_name: "הרב כהן", is_active: true, join_code: "SECRET" };
const LESSONS = [
  { id: 1, title: "א", media_type: "audio", completed_at: "2026-11-01T10:00:00Z" },
  { id: 2, title: "ב", media_type: "text", completed_at: null },
  { id: 3, title: "ג", media_type: "video", completed_at: null, last_position_seconds: 120 },
  { id: 4, title: "ד", media_type: "audio", completed_at: null },
];

const db = (caller, { enrolled = [], inCourse = [1, 2, 3, 4] } = {}) =>
  stubPoolQuery(pool, (text) => {
    if (/FROM courses c LEFT JOIN users/.test(text)) return { rows: [COURSE] };
    if (/SELECT course_id FROM enrollments/.test(text)) return { rows: enrolled.map((course_id) => ({ course_id })) };
    if (/LEFT JOIN watch_progress/.test(text)) return { rows: LESSONS };
    if (/SELECT id FROM media_items WHERE course_id/.test(text)) return { rows: inCourse.map((id) => ({ id })) };
    if (/FROM users/.test(text)) return { rows: [caller] };
    return { rows: [] };
  });

test("progress counts recordings, and the next is the first unfinished in order", () => {
  assert.deepEqual(trackSummary(LESSONS), { total: 3, completed: 1, nextId: 3 });
  assert.deepEqual(trackSummary(LESSONS.map((l) => ({ ...l, completed_at: "x" }))), { total: 3, completed: 3, nextId: null });
  assert.deepEqual(trackSummary([]), { total: 0, completed: 0, nextId: null });
});

test("an enrolled student follows the track, with their own progress", async () => {
  const stub = db(STUDENT, { enrolled: [4] });
  try {
    const res = await request(app).get("/api/courses/4/lessons").set("Cookie", cookieFor(STUDENT));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.summary, { total: 3, completed: 1, nextId: 3 });
    assert.equal(res.body.canArrange, false);
    // The course as a track carries no join code.
    assert.equal("join_code" in res.body.course, false);
    const query = stub.calls.find((c) => /LEFT JOIN watch_progress/.test(c.text));
    assert.match(query.text, /wp\.user_id = \$2/);
    assert.match(query.text, /ORDER BY m\.course_position NULLS LAST, m\.created_at/);
    assert.deepEqual(query.params.slice(0, 3), [4, STUDENT.id, [4]]);
  } finally {
    stub.restore();
  }
});

test("a student not in the course is told to join, not shown an empty track", async () => {
  const stub = db(STUDENT, { enrolled: [] });
  try {
    const res = await request(app).get("/api/courses/4/lessons").set("Cookie", cookieFor(STUDENT));
    assert.equal(res.status, 403);
    assert.equal(stub.calls.some((c) => /LEFT JOIN watch_progress/.test(c.text)), false);
  } finally {
    stub.restore();
  }
});

test("the course's lecturer may arrange it; another lecturer may follow it but not arrange it", async () => {
  for (const [caller, canArrange] of [[OWNER, true], [OTHER, false]]) {
    const stub = db(caller);
    try {
      const res = await request(app).get("/api/courses/4/lessons").set("Cookie", cookieFor(caller));
      assert.equal(res.status, 200);
      assert.equal(res.body.canArrange, canArrange);
    } finally {
      stub.restore();
    }
  }
  const stub = db(OTHER);
  try {
    const res = await request(app).put("/api/courses/4/lessons/order").set("Cookie", cookieFor(OTHER)).send({ mediaIds: [4, 3, 2, 1] });
    assert.equal(res.status, 403);
    assert.equal(stub.calls.some((c) => /course_position = o\.pos/.test(c.text)), false);
  } finally {
    stub.restore();
  }
});

test("arranging writes the whole order in one statement", async () => {
  const stub = db(OWNER);
  try {
    const res = await request(app).put("/api/courses/4/lessons/order").set("Cookie", cookieFor(OWNER)).send({ mediaIds: [4, 3, 2, 1] });
    assert.equal(res.status, 200);
    const update = stub.calls.filter((c) => /course_position = o\.pos/.test(c.text));
    assert.equal(update.length, 1);
    assert.match(update[0].text, /WITH ORDINALITY/);
    assert.match(update[0].text, /m\.course_id = \$1/);
    assert.equal(Number(update[0].params[0]), 4);
    assert.deepEqual(update[0].params[1], [4, 3, 2, 1]);
  } finally {
    stub.restore();
  }
});

// Half an order, or a lesson from another course named into this one.
test("an order that is not exactly this course's lessons is refused, and nothing is written", async () => {
  for (const mediaIds of [[1, 2, 3], [1, 2, 3, 4, 99], [1, 2, 3, 99]]) {
    const stub = db(OWNER);
    try {
      const res = await request(app).put("/api/courses/4/lessons/order").set("Cookie", cookieFor(OWNER)).send({ mediaIds });
      assert.equal(res.status, 400, JSON.stringify(mediaIds));
      assert.equal(stub.calls.some((c) => /course_position = o\.pos/.test(c.text)), false);
    } finally {
      stub.restore();
    }
  }
});

// The rule itself runs only against a real database (npm run smoke); this pins
// that saving a position can stamp completion and never un-stamps it.
test("saving a position stamps completion at nine tenths, and keeps an earlier stamp", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [{}] }));
  try {
    await saveWatchProgress(13, 1, 500);
    const { text } = stub.calls[0];
    assert.match(text, /\$3::int >= m\.duration_seconds \* 0\.9/);
    assert.match(text, /completed_at = COALESCE\(watch_progress\.completed_at/);
  } finally {
    stub.restore();
  }
});

// ── The lecturer's report (PRD CRS-4) ───────────────────────────────────────


test("the report crosses every student with every recording, and totals both ways", () => {
  const report = buildCourseReport(
    [{ id: 1, title: "א" }, { id: 3, title: "ג" }],
    [{ id: 13, display_name: "דנה" }, { id: 14, display_name: "יוסי" }],
    [
      { user_id: 13, media_id: 1, completed_at: "2026-11-01T10:00:00Z", last_position_seconds: 600, last_watched_at: "2026-11-01T10:00:00Z" },
      { user_id: 13, media_id: 3, completed_at: null, last_position_seconds: 90, last_watched_at: "2026-11-02T09:00:00Z" },
      // Played once and left at zero: not "started".
      { user_id: 14, media_id: 1, completed_at: null, last_position_seconds: 0, last_watched_at: "2026-11-01T08:00:00Z" },
    ]
  );
  const [dana, yossi] = report.students;
  assert.deepEqual(dana.cells, { 1: { status: "done", position: 600 }, 3: { status: "started", position: 90 } });
  assert.deepEqual([dana.completed, dana.started, dana.lastActivity], [1, 1, "2026-11-02T09:00:00.000Z"]);
  assert.deepEqual(yossi.cells[1], { status: "none", position: 0 });
  assert.deepEqual(yossi.cells[3], { status: "none", position: 0 });
  assert.deepEqual(report.lessons.map((l) => l.completedBy), [1, 0]);
});

test("the report is the course's lecturer's alone, and counts only its enrolled students", async () => {
  const other = db(OTHER);
  try {
    const res = await request(app).get("/api/courses/4/report").set("Cookie", cookieFor(OTHER));
    assert.equal(res.status, 403);
  } finally {
    other.restore();
  }
  const student = db(STUDENT, { enrolled: [4] });
  try {
    const res = await request(app).get("/api/courses/4/report").set("Cookie", cookieFor(STUDENT));
    assert.equal(res.status, 403);
  } finally {
    student.restore();
  }
  const owner = db(OWNER);
  try {
    const res = await request(app).get("/api/courses/4/report").set("Cookie", cookieFor(OWNER));
    assert.equal(res.status, 200);
    const progress = owner.calls.find((c) => /FROM watch_progress wp/.test(c.text));
    // A student who left the course takes their listening with them.
    assert.match(progress.text, /JOIN enrollments e ON e\.student_id = wp\.user_id AND e\.course_id = m\.course_id/);
    assert.match(progress.text, /media_type <> 'text'/);
  } finally {
    owner.restore();
  }
});
