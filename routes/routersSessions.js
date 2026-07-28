import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import { validateIntParam } from "../middleware/validateIntParam.js";
import * as controllersSessions from "../controllers/controllersSessions.js";

const router = Router();

router.use(verifyToken);

router.post("/create", controllersSessions.createSession);
router.get("/active", controllersSessions.getActiveSessions);
router.get("/:id", validateIntParam("id"), controllersSessions.getSessionById);
router.delete("/:id/end", validateIntParam("id"), controllersSessions.endSession);
router.post("/:id/recording", validateIntParam("id"), controllersSessions.saveRecording);

export default router;
