import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import * as controllersTranscripts from "../controllers/controllersTranscripts.js";

const router = Router();

router.use(verifyToken);

router.get("/search", controllersTranscripts.searchTranscripts);
router.get("/:mediaId", controllersTranscripts.getTranscript);
router.put("/:mediaId", requireRole("lecturer", "admin"), controllersTranscripts.updateTranscript);
router.post("/:mediaId/trigger", requireRole("lecturer", "admin"), controllersTranscripts.triggerPipeline);
router.post("/:mediaId/fix-hebrew", requireRole("lecturer", "admin"), controllersTranscripts.fixHebrew);
router.post("/:mediaId/key-point-headings", requireRole("lecturer", "admin"), controllersTranscripts.generateKeyPointHeadings);

export default router;
