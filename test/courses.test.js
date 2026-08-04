import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import * as servicesCourses from "../services/servicesCourses.js";
import * as controllersCourses from "../controllers/controllersCourses.js";

const ADMIN = { id: 1, role: "admin" };
const OWNER = { id: 2, role: "lecturer" };   // teaches course 10
const OTHER = { id: 3, role: "lecturer" };
const STUDENT = { id: 4, role: "student" };

const COURSE = { id: 10, title: "גמרא", lecturer_id: 2, is_active: true };

const fakeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
};

const stubDb = (over = {}) =>
  stubPoolQuery(pool, (text) => {
    if (/FROM courses c/i.test(text)) return { rows: over.course === null ? [] : [over.course ?? COURSE] };
    if (/SELECT role FROM users/i.test(text)) return { rows: over.user === null ? [] : [over.user ?? { role: "lecturer" }] };
    if (/INSERT INTO courses/i.test(text)) return { rows: [{ id: 10 }] };
    if (/UPDATE courses/i.test(text)) return { rows: [{ id: 10 }] };
    if (/DELETE FROM courses/i.test(text)) return { rows: [{ id: 10 }] };
    if (/INSERT INTO enrollments/i.test(text)) {
      if (over.duplicate) { const e = new Error("dup"); e.code = "23505"; throw e; }
      return { rows: [{ id: 99, student_id: 4, course_id: 10 }] };
    }
    return { rows: [] };
  });

const withDb = async (fn, over) => {
  const db = stubDb(over);
  try { return await fn(db); } finally { db.restore(); }
};

// ── course ownership ────────────────────────────────────────────────────────

test("a lecturer may update the course they teach", async () => {
  await withDb(async () => {
    const res = fakeRes();
    await controllersCourses.updateCourse({ user: OWNER, params: { id: "10" }, body: { title: "x" } }, res);
    assert.equal(res.statusCode, 200);
  });
});

test("a lecturer may not update someone else's course", async () => {
  await withDb(async () => {
    const err = await controllersCourses
      .updateCourse({ user: OTHER, params: { id: "10" }, body: { title: "x" } }, fakeRes())
      .catch((e) => e);
    assert.equal(err.statusCode, 403);
  });
});

test("an admin may update any course", async () => {
  await withDb(async () => {
    const res = fakeRes();
    await controllersCourses.updateCourse({ user: ADMIN, params: { id: "10" }, body: { title: "x" } }, res);
    assert.equal(res.statusCode, 200);
  });
});

// Reassigning the lecturer is how a course would be taken over or abandoned.
test("a lecturer may not reassign their course to someone else", async () => {
  await withDb(async () => {
    const err = await controllersCourses
      .updateCourse({ user: OWNER, params: { id: "10" }, body: { lecturerId: 3 } }, fakeRes())
      .catch((e) => e);
    assert.equal(err.statusCode, 403);
  });
});

test("a lecturer may not delete someone else's course", async () => {
  await withDb(async () => {
    const err = await controllersCourses
      .deleteCourse({ user: OTHER, params: { id: "10" } }, fakeRes())
      .catch((e) => e);
    assert.equal(err.statusCode, 403);
  });
});

// A lecturer creating a course must own it, or they could file it under someone
// else's name.
test("a lecturer's new course is assigned to themselves, whatever they send", async () => {
  await withDb(async (db) => {
    await controllersCourses.createCourse(
      { user: OWNER, body: { title: "חדש", lecturerId: 999 } },
      fakeRes()
    );
    const insert = db.calls.find((c) => /INSERT INTO courses/i.test(c.text));
    assert.equal(insert.params[2], OWNER.id);
  });
});

test("an admin may create a course on another lecturer's behalf", async () => {
  await withDb(async (db) => {
    await controllersCourses.createCourse(
      { user: ADMIN, body: { title: "חדש", lecturerId: 3 } },
      fakeRes()
    );
    const insert = db.calls.find((c) => /INSERT INTO courses/i.test(c.text));
    assert.equal(insert.params[2], 3);
  });
});

// ── validation ──────────────────────────────────────────────────────────────

test("a course cannot be taught by a student", async () => {
  await withDb(
    async () => {
      await assert.rejects(
        () => servicesCourses.createCourse({ title: "x", lecturerId: 4 }),
        { statusCode: 400 }
      );
    },
    { user: { role: "student" } }
  );
});

test("a blank title is refused before touching the database", async () => {
  await assert.rejects(() => servicesCourses.createCourse({ title: "   " }), { statusCode: 400 });
});

// ── enrollments ─────────────────────────────────────────────────────────────

test("enrolling the same student twice is a conflict, not a 500", async () => {
  await withDb(
    async () => {
      const err = await servicesCourses.enrollStudent(10, 4).catch((e) => e);
      assert.equal(err.statusCode, 409);
    },
    { duplicate: true, user: { role: "student" } }
  );
});

test("a student may read their own enrollments", async () => {
  await withDb(async () => {
    const res = fakeRes();
    await controllersCourses.getStudentCourses(
      { user: STUDENT, params: { studentId: "4" } },
      res
    );
    assert.equal(res.statusCode, 200);
  });
});

test("a student may not read another student's enrollments", async () => {
  await withDb(async () => {
    const err = await controllersCourses
      .getStudentCourses({ user: STUDENT, params: { studentId: "5" } }, fakeRes())
      .catch((e) => e);
    assert.equal(err.statusCode, 403);
  });
});

test("an admin may read anyone's enrollments", async () => {
  await withDb(async () => {
    const res = fakeRes();
    await controllersCourses.getStudentCourses({ user: ADMIN, params: { studentId: "5" } }, res);
    assert.equal(res.statusCode, 200);
  });
});
