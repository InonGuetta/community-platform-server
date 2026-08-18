// @ts-check
import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import * as controllersAdmin from "../controllers/controllersAdmin.js";

const router = Router();

router.use(verifyToken, requireRole("admin"));

router.get("/stats", controllersAdmin.getStats);
router.get("/queue-status", controllersAdmin.getQueueStatus);
router.get("/system-health", controllersAdmin.getSystemHealth);

// What broke and what never started. Read-only; the action for it is below.
router.get("/pipeline-trouble", controllersAdmin.getPipelineTrouble);

// Queues transcription jobs, each of which is a real Whisper bill — so it is a
// POST, and the sweep bounds itself per run (MAX_RECONCILE_PER_RUN).
router.post("/reconcile", controllersAdmin.runReconcile);

router.get("/donations", controllersAdmin.getDonations);

export default router;
