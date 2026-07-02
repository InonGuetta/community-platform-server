import { Router } from "express";
import rateLimit from "express-rate-limit";
import { verifyToken } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { validateIntParam } from "../middleware/validateIntParam.js";
import * as controllersTranscripts from "../controllers/controllersTranscripts.js";

const router = Router();

// Each search runs an OpenAI embedding + a GPT-4o rerank, so it costs real money
// per call. Cap it per client so a tight loop can't run up the OpenAI bill.
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many searches, please try again in a minute" },
});

router.use(verifyToken);

router.get("/search", searchLimiter, controllersTranscripts.searchTranscripts);
router.get("/:mediaId", validateIntParam("mediaId"), controllersTranscripts.getTranscript);
router.put("/:mediaId", requireRole("lecturer", "admin"), validateIntParam("mediaId"), controllersTranscripts.updateTranscript);
router.post("/:mediaId/trigger", requireRole("lecturer", "admin"), validateIntParam("mediaId"), controllersTranscripts.triggerPipeline);
router.post("/:mediaId/fix-hebrew", requireRole("lecturer", "admin"), validateIntParam("mediaId"), controllersTranscripts.fixHebrew);
router.post("/:mediaId/key-point-headings", requireRole("lecturer", "admin"), validateIntParam("mediaId"), controllersTranscripts.generateKeyPointHeadings);

export default router;
