// @ts-check
import * as servicesCourses from "../services/servicesCourses.js";
import { optionalId } from "../lib/validate.js";
import { forbidden, badRequest } from "../lib/AppError.js";

// Managing a course follows the same shape as managing media: an admin may touch
// any course, a lecturer only the ones they are responsible for. Kept next to the
// handlers rather than in lib/permissions.js because it reads a course row, not a
// media row — the two rules are similar but not the same one.
const assertCanManageCourse = (user, course) => {
  if (user?.role === "admin") return;
  const owner = Number(course?.lecturer_id);
  const caller = Number(user?.id);
  if (Number.isInteger(owner) && Number.isInteger(caller) && owner === caller) return;
  throw forbidden("You may only manage courses you teach");
};

export const getAllCourses = async (req, res) => {
  const courses = await servicesCourses.getAllCourses();
  res.status(200).json(courses);
};

export const getCourseById = async (req, res) => {
  const course = await servicesCourses.getCourseById(req.params.id);
  res.status(200).json(course);
};

export const createCourse = async (req, res) => {
  const { title, description, lecturerId } = req.body ?? {};
  // A lecturer creating a course owns it by default; only an admin may hand a
  // course to somebody else, otherwise a lecturer could create courses in
  // another lecturer's name.
  const owner =
    req.user.role === "admin" ? optionalId(lecturerId, "lecturerId") : req.user.id;
  const course = await servicesCourses.createCourse({ title, description, lecturerId: owner });
  res.status(201).json(course);
};

export const updateCourse = async (req, res) => {
  const existing = await servicesCourses.getCourseById(req.params.id);
  assertCanManageCourse(req.user, existing);

  const { title, description, lecturerId, isActive } = req.body ?? {};
  // Reassigning a course to a different lecturer is an admin action: a lecturer
  // doing it to themselves would be a way to take over someone else's course,
  // and doing it away from themselves would be a way to abandon one.
  if (lecturerId !== undefined && req.user.role !== "admin") {
    throw forbidden("Only an admin may change a course's lecturer");
  }

  const course = await servicesCourses.updateCourse(req.params.id, {
    title,
    description,
    lecturerId: optionalId(lecturerId, "lecturerId"),
    isActive,
  });
  res.status(200).json(course);
};

export const deleteCourse = async (req, res) => {
  const existing = await servicesCourses.getCourseById(req.params.id);
  assertCanManageCourse(req.user, existing);
  const result = await servicesCourses.deleteCourse(req.params.id);
  res.status(200).json(result);
};

// ── Enrollments ─────────────────────────────────────────────────────────────

// Ownership, not just role — and it is the only handler in this file that was
// missing it.
//
// requireRole("lecturer","admin") on the route establishes that the caller may
// read SOME roster. It cannot establish WHICH, because it runs before the course
// row is loaded. Without the check below, every lecturer could read the student
// list of every course in the system: names and email addresses of people they
// do not teach.
//
// A read, so it could reasonably have answered 404 to hide the course's
// existence — but the catalogue is already readable by any signed-in user
// (GET /courses), so there is nothing left to hide and 403 is the honest answer.
// That is the same reasoning assertCanManageMedia records for the write paths.
export const getCourseStudents = async (req, res) => {
  assertCanManageCourse(req.user, await servicesCourses.getCourseById(req.params.id));
  const students = await servicesCourses.getCourseStudents(req.params.id);
  res.status(200).json(students);
};

// A student may always ask which courses they are in; anyone else asking about a
// specific student is an admin action.
export const getStudentCourses = async (req, res) => {
  const requested = Number(req.params.studentId);
  if (requested !== Number(req.user.id) && req.user.role !== "admin") {
    throw forbidden("You may only view your own courses");
  }
  const courses = await servicesCourses.getStudentCourses(requested);
  res.status(200).json(courses);
};

export const getMyCourses = async (req, res) => {
  const courses = await servicesCourses.getStudentCourses(req.user.id);
  res.status(200).json(courses);
};

// Enrolment moved from admin-only to the lecturer who teaches the course.
//
// The comment that used to sit on these routes said "a lecturer runs their
// course; they do not decide its roster". That was a real decision and it has
// been reversed deliberately — a lecturer managing their own roster is the whole
// of R4 — so the comment is gone rather than left contradicting the code under
// it.
//
// What did NOT change is that it takes two layers. requireRole says a lecturer
// may enrol somebody SOMEWHERE; assertCanManageCourse says which course. Without
// the second, opening the first would let any lecturer add students to every
// course on the platform.
export const enrollStudent = async (req, res) => {
  assertCanManageCourse(req.user, await servicesCourses.getCourseById(req.params.id));
  const studentId = optionalId(req.body?.studentId, "studentId");
  if (studentId === null || studentId === undefined) throw badRequest("studentId is required");
  const enrollment = await servicesCourses.enrollStudent(req.params.id, studentId);
  res.status(201).json(enrollment);
};

export const unenrollStudent = async (req, res) => {
  assertCanManageCourse(req.user, await servicesCourses.getCourseById(req.params.id));
  const result = await servicesCourses.unenrollStudent(req.params.id, req.params.studentId);
  res.status(200).json(result);
};

// Who this lecturer teaches, across every course they run. Takes no id: it
// answers for the CALLER, which is what makes it safe to expose to a lecturer at
// all — there is no parameter to point at somebody else.
//
// An admin calling it sees the students of the courses THEY are the lecturer of,
// which is usually none. That is the honest answer to "who learns with me";
// "every student on the platform" is a different question and get-all-users
// already answers it.
export const getMyStudents = async (req, res) => {
  const students = await servicesCourses.getStudentsOfLecturer(req.user.id);
  res.status(200).json(students);
};

// The type-ahead behind "add a student". Ownership-gated like the roster itself:
// without that, it is a membership search anyone who got approved as a lecturer
// could run against the whole platform.
export const getEnrollableStudents = async (req, res) => {
  assertCanManageCourse(req.user, await servicesCourses.getCourseById(req.params.id));
  const users = await servicesCourses.searchEnrollableUsers(req.params.id, req.query.q);
  res.status(200).json(users);
};
