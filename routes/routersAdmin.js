import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import * as controllersAdmin from "../controllers/controllersAdmin.js";

const router = Router();

router.use(verifyToken, requireRole("admin"));

router.get("/stats", controllersAdmin.getStats);
router.get("/queue-status", controllersAdmin.getQueueStatus);
router.get("/system-health", controllersAdmin.getSystemHealth);

export default router;
