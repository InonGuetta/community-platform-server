// @ts-check
import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import { validateIntParam } from "../middleware/validateIntParam.js";
import * as controllersNotifications from "../controllers/controllersNotifications.js";

// Every signed-in user has an inbox; what is in it is decided by notify(), not
// by role. No requireRole, and test/roleMatrix.test.js says so.
const router = Router();

router.use(verifyToken);

router.get("/", controllersNotifications.getNotifications);
// Before "/:id/read", so "read-all" is never taken for an id — validateIntParam
// would refuse it with a 400 rather than fall through.
router.post("/read-all", controllersNotifications.markAllRead);
router.post("/:id/read", validateIntParam("id"), controllersNotifications.markRead);

export default router;
