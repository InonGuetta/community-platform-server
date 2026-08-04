import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { validateIntParam } from "../middleware/validateIntParam.js";
import * as controllersCourses from "../controllers/controllersCourses.js";

const router = Router();

router.use(verifyToken);

const canManage = requireRole("lecturer", "admin");
// Enrollment is who-may-see-what, so it stays with the admin — the same place
// role changes live. A lecturer runs their course; they do not decide its roster.
const adminOnly = requireRole("admin");

// Before "/:id" — validateIntParam would otherwise reject the literal "my" as a
// malformed id and this route would be unreachable.
router.get("/my", controllersCourses.getMyCourses);

// Any signed-in user may read the catalogue. Enrollment governs which LESSONS a
// student sees, not whether courses exist — hiding the list would also hide the
// course name shown beside a lesson they are entitled to.
router.get("/", controllersCourses.getAllCourses);
router.get("/:id", validateIntParam("id"), controllersCourses.getCourseById);

router.post("/", canManage, controllersCourses.createCourse);
// Ownership (an admin, or the lecturer who teaches it) is enforced in the
// controller, where the course row has been loaded — requireRole runs before it
// exists, exactly as with media.
router.put("/:id", canManage, validateIntParam("id"), controllersCourses.updateCourse);
router.delete("/:id", canManage, validateIntParam("id"), controllersCourses.deleteCourse);

router.get("/:id/students", canManage, validateIntParam("id"), controllersCourses.getCourseStudents);
router.post("/:id/students", adminOnly, validateIntParam("id"), controllersCourses.enrollStudent);
router.delete(
  "/:id/students/:studentId",
  adminOnly,
  validateIntParam("id"),
  validateIntParam("studentId"),
  controllersCourses.unenrollStudent
);

// A student's own enrollments. The controller allows self or admin.
router.get(
  "/students/:studentId/enrollments",
  validateIntParam("studentId"),
  controllersCourses.getStudentCourses
);

export default router;
