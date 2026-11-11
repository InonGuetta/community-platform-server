// @ts-check
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { validateIntParam } from "../middleware/validateIntParam.js";
import * as controllersPublic from "../controllers/controllersPublic.js";
import * as controllersMediaFiles from "../controllers/controllersMediaFiles.js";

// What anyone with a link may open, signed in or not (PRD COM-3b, COM-4).
//
// The only router with no verifyToken at all — every route here is public by
// design, and each answers only for a lesson its manager made public (and that
// is published): the row decides, not the caller. Anything else is a 404.
//
// Limited per IP, since there is no user to limit by: generous enough for a
// player's range requests while one person listens, tight enough that the
// endpoint cannot be used to walk the id space at speed.
const router = Router();

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again in a minute" },
});

router.use(publicLimiter);

router.get("/media/:id", validateIntParam("id"), controllersPublic.getPublicLesson);
router.get("/media/:id/stream", validateIntParam("id"), controllersMediaFiles.streamPublicMedia);
// The link that is shared: Open Graph tags for a WhatsApp preview, then a
// redirect to the guest page.
router.get("/share/:id", validateIntParam("id"), controllersPublic.sharePage);

export default router;
