// @ts-check
import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { validateIntParam } from "../middleware/validateIntParam.js";
import * as controllersUsers from "../controllers/controllersUsers.js";

const router = Router();

router.use(verifyToken, requireRole("admin"));

router.get("/get-all-users", controllersUsers.getAllUsers);

// Role approval. BEFORE "/:id" — validateIntParam would otherwise reject the
// literal "pending" as a malformed id and this route would be unreachable. Same
// hazard, and same fix, as "/my" in routersCourses.
router.get("/pending", controllersUsers.getPendingApprovals);
router.post("/:id/approve", validateIntParam("id"), controllersUsers.approveUser);
router.post("/:id/reject", validateIntParam("id"), controllersUsers.rejectUser);

router.get("/:id", validateIntParam("id"), controllersUsers.getUserById);
router.post("/create-user", controllersUsers.createUser);
router.put("/update-user/:id", validateIntParam("id"), controllersUsers.updateUser);
router.delete("/delete-user/:id", validateIntParam("id"), controllersUsers.deleteUser);

export default router;
