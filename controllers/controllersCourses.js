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

export const getCourseStudents = async (req, res) => {
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

export const enrollStudent = async (req, res) => {
  const studentId = optionalId(req.body?.studentId, "studentId");
  if (studentId === null || studentId === undefined) throw badRequest("studentId is required");
  const enrollment = await servicesCourses.enrollStudent(req.params.id, studentId);
  res.status(201).json(enrollment);
};

export const unenrollStudent = async (req, res) => {
  const result = await servicesCourses.unenrollStudent(req.params.id, req.params.studentId);
  res.status(200).json(result);
};
