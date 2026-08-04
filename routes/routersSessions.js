import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { validateIntParam } from "../middleware/validateIntParam.js";
import * as controllersSessions from "../controllers/controllersSessions.js";

const router = Router();

router.use(verifyToken);

// Hosting a session was lecturer/admin-only in the UI but open to anyone on the
// API — the client merely hid the button.
const canHost = requireRole("lecturer", "admin");

router.post("/create", canHost, controllersSessions.createSession);
router.get("/active", controllersSessions.getActiveSessions);
router.get("/:id", validateIntParam("id"), controllersSessions.getSessionById);
// These two were the only routes whose authorization lived solely in the service
// layer — the "AND host_id=$2" in the UPDATE. That check is the real one and
// stays; requireRole is the cheap first layer that makes the rule visible here
// rather than only in a WHERE clause. Only lecturers and admins can create a
// session, so nobody else can be a host in the first place.
router.delete("/:id/end", canHost, validateIntParam("id"), controllersSessions.endSession);
router.post("/:id/recording", canHost, validateIntParam("id"), controllersSessions.saveRecording);

export default router;
