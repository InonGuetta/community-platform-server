import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { validateIntParam } from "../middleware/validateIntParam.js";
import * as controllersSessions from "../controllers/controllersSessions.js";

const router = Router();

router.use(verifyToken);

// Hosting a session was lecturer/admin-only in the UI but open to anyone on the
// API — the client merely hid the button.
router.post("/create", requireRole("lecturer", "admin"), controllersSessions.createSession);
router.get("/active", controllersSessions.getActiveSessions);
router.get("/:id", validateIntParam("id"), controllersSessions.getSessionById);
router.delete("/:id/end", validateIntParam("id"), controllersSessions.endSession);
router.post("/:id/recording", validateIntParam("id"), controllersSessions.saveRecording);

export default router;
