// @ts-check
import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import { validateIntParam } from "../middleware/validateIntParam.js";
import { userRateLimit } from "../middleware/userRateLimit.js";
import * as controllersDiscussion from "../controllers/controllersDiscussion.js";

const router = Router();

// The "דיון עם AI" tab on a lesson page. Everything here is about one lesson
// the caller may already see, and the only rows it writes are the caller's own
// conversation — so there is no requireRole: the question is visibility, which
// the service answers from lib/permissions.js like every other read of a
// lesson, and ownership, which it settles by never taking a conversation id
// from the request.

// Each search is an OpenAI embedding plus a GPT-4o rerank. Counted per user
// (see userRateLimit), and separate from the library-wide search's budget so a
// student working through one lesson does not lock themselves out of the other.
const searchLimiter = userRateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: "Too many searches, please try again in a minute",
});

// Starting a conversation is one cheap INSERT — the limit is only there so a
// script cannot fill the table with empty rows.
const conversationLimiter = userRateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: "Too many requests, please try again in a minute",
});

// Each question is a GPT-4o answer over up to ~25k tokens of lesson text, and
// for a long lesson also an embedding, a rerank and a rewrite. The tightest
// budget here: ten questions a minute is more than anyone reads answers at.
const chatLimiter = userRateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: "Too many questions, please try again in a minute",
});

router.use(verifyToken);

router.get("/:mediaId/search", validateIntParam("mediaId"), searchLimiter, controllersDiscussion.searchWithinMedia);
router.get("/:mediaId/conversation", validateIntParam("mediaId"), controllersDiscussion.getConversation);
router.post("/:mediaId/conversation", validateIntParam("mediaId"), conversationLimiter, controllersDiscussion.startConversation);
router.post("/:mediaId/messages", validateIntParam("mediaId"), chatLimiter, controllersDiscussion.postMessage);

export default router;
