import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import { validateIntParam } from "../middleware/validateIntParam.js";
import * as controllersLikes from "../controllers/controllersLikes.js";

const router = Router();

router.use(verifyToken);

router.get("/", controllersLikes.getLikes);
router.post("/", controllersLikes.createLike);
// Keyed by mediaId rather than the like's own id: the client knows which
// lecture it is looking at, and would otherwise have to find the like row first
// just to remove it.
router.delete("/:mediaId", validateIntParam("mediaId"), controllersLikes.deleteLike);

export default router;
