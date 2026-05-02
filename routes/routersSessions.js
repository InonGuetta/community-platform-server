import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import * as controllersSessions from "../controllers/controllersSessions.js";

const router = Router();

router.use(verifyToken);

router.post("/create", controllersSessions.createSession);
router.get("/active", controllersSessions.getActiveSessions);
router.get("/:id", controllersSessions.getSessionById);
router.delete("/:id/end", controllersSessions.endSession);
router.post("/:id/recording", controllersSessions.saveRecording);

export default router;
