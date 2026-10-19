// @ts-check
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

// The two on-demand AI routes run synchronously inside the request and issue a
// GPT-4o call per batch — a three-hour transcript is roughly a dozen paid calls
// over several minutes. The in-flight lock stops the same media being processed
// twice at once; this caps how fast the whole library can be worked through.
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many AI requests, please try again in a minute" },
});

router.use(verifyToken);

// TODO(CR): both limiters are keyed by IP (the default). A yeshiva shares one
// public IP, so 20 searches/min is the budget for the whole building, while one
// person with a few IPs is barely slowed. Key on req.user.id (keyGenerator) now
// that verifyToken runs first. Also aiLimiter is placed BEFORE requireRole on the
// two AI routes, so a student's refused requests consume the lecturers' budget —
// put requireRole first.
router.get("/search", searchLimiter, controllersTranscripts.searchTranscripts);
router.get("/:mediaId", validateIntParam("mediaId"), controllersTranscripts.getTranscript);
router.put("/:mediaId", requireRole("lecturer", "admin"), validateIntParam("mediaId"), controllersTranscripts.updateTranscript);
router.post("/:mediaId/trigger", requireRole("lecturer", "admin"), validateIntParam("mediaId"), controllersTranscripts.triggerPipeline);
router.post("/:mediaId/fix-hebrew", aiLimiter, requireRole("lecturer", "admin"), validateIntParam("mediaId"), controllersTranscripts.fixHebrew);
router.post("/:mediaId/key-point-headings", aiLimiter, requireRole("lecturer", "admin"), validateIntParam("mediaId"), controllersTranscripts.generateKeyPointHeadings);

export default router;
