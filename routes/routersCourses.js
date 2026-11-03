// @ts-check
import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { validateIntParam } from "../middleware/validateIntParam.js";
import { userRateLimit } from "../middleware/userRateLimit.js";
import * as controllersCourses from "../controllers/controllersCourses.js";

const router = Router();

router.use(verifyToken);

const canManage = requireRole("lecturer", "admin");

// The "add a student" type-ahead searches the membership. Per user, because
// that is who could walk it; generous, because it fires as somebody types.
const enrollSearchLimiter = userRateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: "Too many searches, please try again in a minute",
});

// Typing a join code (PRD ROST-9). Per user and tight: a code is six
// characters from 31, and this is what keeps guessing one from being a loop.
// A real student mistypes a few times, not ten in a quarter of an hour.
const joinLimiter = userRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many join attempts, please try again later",
});

// Before "/:id", like "/my" below: anybody signed in may ask to join, and
// manage their own waiting requests.
router.post("/join", joinLimiter, controllersCourses.joinByCode);
router.get("/join-requests/mine", controllersCourses.getMyJoinRequests);
router.delete("/join-requests/:requestId", validateIntParam("requestId"), controllersCourses.cancelMyJoinRequest);

// Before "/:id" — validateIntParam would otherwise reject the literal "my" as a
// malformed id and this route would be unreachable.
router.get("/my", controllersCourses.getMyCourses);

// Also before "/:id", and for the same reason: validateIntParam would reject
// the literal "my-students" as a malformed id and this route would be dead.
router.get("/my-students", canManage, controllersCourses.getMyStudents);

// Any signed-in user may read the catalogue. Enrollment governs which LESSONS a
// student sees, not whether courses exist — hiding the list would also hide the
// course name shown beside a lesson they are entitled to.
//
// That first sentence used to be false, and had been since courses were added:
// it described the intent while getAllMedia filtered on is_published alone, and
// the comment there said so in as many words — two files stating opposite things
// about the same rule. Enrolment now genuinely governs it, through the shared
// predicate in lib/permissions.js. A lesson with no course_id is the general
// library and stays visible to everyone, which is what every item uploaded before
// courses existed is.
router.get("/", controllersCourses.getAllCourses);
router.get("/:id", validateIntParam("id"), controllersCourses.getCourseById);

router.post("/", canManage, controllersCourses.createCourse);
// Ownership (an admin, or the lecturer who teaches it) is enforced in the
// controller, where the course row has been loaded — requireRole runs before it
// exists, exactly as with media.
router.put("/:id", canManage, validateIntParam("id"), controllersCourses.updateCourse);
router.delete("/:id", canManage, validateIntParam("id"), controllersCourses.deleteCourse);

router.get("/:id/students", canManage, validateIntParam("id"), controllersCourses.getCourseStudents);
router.post("/:id/students", canManage, validateIntParam("id"), controllersCourses.enrollStudent);
router.get(
  "/:id/enrollable-students",
  canManage,
  enrollSearchLimiter,
  validateIntParam("id"),
  controllersCourses.getEnrollableStudents
);
router.delete(
  "/:id/students/:studentId",
  canManage,
  validateIntParam("id"),
  validateIntParam("studentId"),
  controllersCourses.unenrollStudent
);

// The lecturer's half of joining by code: the code itself, and the queue.
router.post("/:id/join-code", canManage, validateIntParam("id"), controllersCourses.createJoinCode);
router.delete("/:id/join-code", canManage, validateIntParam("id"), controllersCourses.removeJoinCode);
router.get("/:id/join-requests", canManage, validateIntParam("id"), controllersCourses.getJoinRequests);
router.post(
  "/:id/join-requests/:requestId/approve",
  canManage,
  validateIntParam("id"),
  validateIntParam("requestId"),
  controllersCourses.approveJoinRequest
);
router.post(
  "/:id/join-requests/:requestId/reject",
  canManage,
  validateIntParam("id"),
  validateIntParam("requestId"),
  controllersCourses.rejectJoinRequest
);

// The course as a track (PRD CRS-1..3): its lessons in order with the caller's
// progress — for anybody following it; arranging them — for its lecturer.
router.get("/:id/lessons", validateIntParam("id"), controllersCourses.getCourseLessons);
router.put("/:id/lessons/order", canManage, validateIntParam("id"), controllersCourses.reorderCourseLessons);

// A student's own enrollments. The controller allows self or admin.
router.get(
  "/students/:studentId/enrollments",
  validateIntParam("studentId"),
  controllersCourses.getStudentCourses
);

export default router;
