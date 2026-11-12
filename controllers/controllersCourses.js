// @ts-check
import * as servicesCourses from "../services/servicesCourses.js";
import * as servicesCourseJoin from "../services/servicesCourseJoin.js";
import * as servicesCourseTrack from "../services/servicesCourseTrack.js";
import { viewerScopeFor } from "../services/servicesVisibility.js";
import { requireIdList } from "../lib/validate.js";
import { notify, notifyAdmins, NOTIFICATION_TYPES } from "../services/servicesNotifications.js";
import { optionalId } from "../lib/validate.js";
import { forbidden, badRequest } from "../lib/AppError.js";
// Managing a course follows the same shape as managing media: an admin may touch
// any course, a lecturer only the ones they are responsible for. In
// lib/permissions.js since uploads need the same rule — see canManageCourse.
import { assertCanManageCourse, canManageCourse, isAdmin, isPrivileged } from "../lib/permissions.js";

// What a reader who does not manage courses gets. student_count is withheld for
// the reason getStudentCourses already gives — a student has no business knowing
// who else is enrolled — which the catalogue was quietly contradicting by
// carrying it on every row. Same shape as publicMedia/publicSession.
//
// The join code and the queue behind it (PRD ROST-9) are narrower still: only
// whoever manages THIS course sees them. A code shown in the catalogue would
// hand every signed-in user — and every other lecturer — the way in.
const publicCourse = (user) => (course) => {
  const { join_code, pending_join_count, ...rest } = course;
  const managed = canManageCourse(user, course) ? { join_code, pending_join_count } : {};
  if (isPrivileged(user)) return { ...rest, ...managed };
  const { student_count, ...publicRest } = rest;
  return publicRest;
};

// A course seen as one of the caller's ENROLMENTS — never with its code, which
// a student could otherwise pass on from the "my courses" screen.
const withoutJoinCode = ({ join_code, pending_join_count, ...course }) => course;

export const getAllCourses = async (req, res) => {
  const courses = await servicesCourses.getAllCourses({ activeOnly: !isPrivileged(req.user) });
  res.status(200).json(courses.map(publicCourse(req.user)));
};

export const getCourseById = async (req, res) => {
  const course = await servicesCourses.getCourseById(req.params.id);
  res.status(200).json(publicCourse(req.user)(course));
};

export const createCourse = async (req, res) => {
  const { title, description, lecturerId } = req.body ?? {};
  // A lecturer creating a course owns it by default; only an admin may hand a
  // course to somebody else, otherwise a lecturer could create courses in
  // another lecturer's name.
  const owner =
    isAdmin(req.user) ? optionalId(lecturerId, "lecturerId") : req.user.id;
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
  if (lecturerId !== undefined && !isAdmin(req.user)) {
    throw forbidden("Only an admin may change a course's lecturer");
  }

  const course = await servicesCourses.updateCourse(req.params.id, {
    title,
    description,
    // Presence decides, as in updateMedia: lecturerId: null detaches the course
    // from its lecturer; leaving the key out leaves it alone.
    setLecturer: "lecturerId" in (req.body ?? {}),
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
  if (requested !== Number(req.user.id) && !isAdmin(req.user)) {
    throw forbidden("You may only view your own courses");
  }
  const courses = await servicesCourses.getStudentCourses(requested);
  res.status(200).json(courses.map(withoutJoinCode));
};

export const getMyCourses = async (req, res) => {
  const courses = await servicesCourses.getStudentCourses(req.user.id);
  res.status(200).json(courses.map(withoutJoinCode));
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

// ── Joining by code (PRD ROST-9) ────────────────────────────────────────────
//
// The lecturer's half is ownership-gated like the roster: requireRole on the
// route says a lecturer may manage SOME course, assertCanManageCourse says this
// one. The student's half needs no role — anybody signed in may ask to join —
// and the code is the only thing that names the course.

export const createJoinCode = async (req, res) => {
  assertCanManageCourse(req.user, await servicesCourses.getCourseById(req.params.id));
  const joinCode = await servicesCourseJoin.setJoinCode(req.params.id);
  res.status(200).json({ joinCode });
};

export const removeJoinCode = async (req, res) => {
  assertCanManageCourse(req.user, await servicesCourses.getCourseById(req.params.id));
  await servicesCourseJoin.clearJoinCode(req.params.id);
  res.status(200).json({ joinCode: null });
};

export const getJoinRequests = async (req, res) => {
  assertCanManageCourse(req.user, await servicesCourses.getCourseById(req.params.id));
  res.status(200).json(await servicesCourseJoin.getPendingJoinRequests(req.params.id));
};

// The answer is told to the person who asked. Not awaited: the decision is
// saved, and notify never throws.
const decide = (approve) => async (req, res) => {
  const course = await servicesCourses.getCourseById(req.params.id);
  assertCanManageCourse(req.user, course);
  const { userId, status } = await servicesCourseJoin.decideJoinRequest(
    req.params.id, req.params.requestId, approve, req.user.id
  );
  void notify(
    userId,
    approve ? NOTIFICATION_TYPES.COURSE_JOIN_APPROVED : NOTIFICATION_TYPES.COURSE_JOIN_REJECTED,
    { courseId: course.id, courseTitle: course.title, lecturerName: course.lecturer_name }
  );
  res.status(200).json({ id: Number(req.params.requestId), status });
};
export const approveJoinRequest = decide(true);
export const rejectJoinRequest = decide(false);

// 202: a request was filed, nobody was enrolled yet. The course is named in
// the answer so the screen can say whose approval is awaited.
export const joinByCode = async (req, res) => {
  const { course, created, requesterName } = await servicesCourseJoin.requestToJoin(req.user.id, req.body?.code);
  if (created) {
    const payload = { courseId: course.id, courseTitle: course.title, requesterName };
    if (course.lecturer_id) void notify(course.lecturer_id, NOTIFICATION_TYPES.COURSE_JOIN_REQUEST, payload);
    else void notifyAdmins(NOTIFICATION_TYPES.COURSE_JOIN_REQUEST, payload);
  }
  res.status(202).json({
    status: "pending",
    course: { id: course.id, title: course.title, lecturer_name: course.lecturer_name },
  });
};

export const getMyJoinRequests = async (req, res) => {
  res.status(200).json(await servicesCourseJoin.getMyJoinRequests(req.user.id));
};

export const cancelMyJoinRequest = async (req, res) => {
  res.status(200).json(await servicesCourseJoin.cancelMyJoinRequest(req.user.id, req.params.requestId));
};

// ── The course as a track (PRD CRS-1, CRS-2, CRS-3) ─────────────────────────

// Its lessons in order, with the caller's own progress through them. For whoever
// may follow the course: a student enrolled in it, a lecturer or an admin. A
// student who is not enrolled is told so (403) rather than shown an empty track
// that would read as a course with no lessons — the catalogue already names it,
// so there is nothing to hide by answering 404.
export const getCourseLessons = async (req, res) => {
  const course = await servicesCourses.getCourseById(req.params.id);
  const scope = await viewerScopeFor(req.user);
  const follows = isPrivileged(req.user) || (scope.courses ?? []).includes(Number(course.id));
  if (!follows) throw forbidden("Join this course to follow its lessons");

  const lessons = await servicesCourseTrack.getCourseLessons(course.id, req.user.id, scope);
  res.status(200).json({
    course: {
      id: course.id, title: course.title, description: course.description,
      lecturer_id: course.lecturer_id, lecturer_name: course.lecturer_name,
    },
    lessons,
    summary: servicesCourseTrack.trackSummary(lessons),
    canArrange: canManageCourse(req.user, course),
  });
};

// The lecturer arranging the track. Ownership-gated like every course write.
export const reorderCourseLessons = async (req, res) => {
  assertCanManageCourse(req.user, await servicesCourses.getCourseById(req.params.id));
  const mediaIds = requireIdList(req.body?.mediaIds, "mediaIds");
  res.status(200).json(await servicesCourseTrack.reorderCourseLessons(req.params.id, mediaIds));
};

// The lecturer's report (PRD CRS-4): who of this course's students heard what.
// The course's manager only — the same people who may read its roster, since
// the report is the roster with listening attached.
export const getCourseReport = async (req, res) => {
  const course = await servicesCourses.getCourseById(req.params.id);
  assertCanManageCourse(req.user, course);
  res.status(200).json(await servicesCourseTrack.getCourseReport(course.id));
};
