// @ts-check
import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { validateIntParam } from "../middleware/validateIntParam.js";
import { userRateLimit } from "../middleware/userRateLimit.js";
import * as controllersTranscripts from "../controllers/controllersTranscripts.js";

const router = Router();

// Both limiters count per signed-in user, not per IP — see userRateLimit for why
// an IP is the wrong unit here. verifyToken runs first, so the user is known.

// Each search runs an OpenAI embedding + a GPT-4o rerank, so it costs real money
// per call. Cap it per user so a tight loop can't run up the OpenAI bill.
const searchLimiter = userRateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: "Too many searches, please try again in a minute",
});

// The two on-demand AI routes run synchronously inside the request and issue a
// GPT-4o call per batch — a three-hour transcript is roughly a dozen paid calls
// over several minutes. The in-flight lock stops the same media being processed
// twice at once; this caps how fast the whole library can be worked through.
const aiLimiter = userRateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: "Too many AI requests, please try again in a minute",
});

router.use(verifyToken);

const canEdit = requireRole("lecturer", "admin");

router.get("/search", searchLimiter, controllersTranscripts.searchTranscripts);
router.get("/:mediaId", validateIntParam("mediaId"), controllersTranscripts.getTranscript);
router.put("/:mediaId", canEdit, validateIntParam("mediaId"), controllersTranscripts.updateTranscript);
router.post("/:mediaId/trigger", canEdit, validateIntParam("mediaId"), controllersTranscripts.triggerPipeline);
// requireRole BEFORE the limiter: a refused caller must not spend the budget.
router.post("/:mediaId/fix-hebrew", canEdit, aiLimiter, validateIntParam("mediaId"), controllersTranscripts.fixHebrew);
router.post("/:mediaId/key-point-headings", canEdit, aiLimiter, validateIntParam("mediaId"), controllersTranscripts.generateKeyPointHeadings);

export default router;
