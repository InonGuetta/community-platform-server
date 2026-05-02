import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import * as controllersBookmarks from "../controllers/controllersBookmarks.js";

const router = Router();

router.use(verifyToken);

router.get("/", controllersBookmarks.getBookmarks);
router.post("/", controllersBookmarks.createBookmark);
router.put("/:id", controllersBookmarks.updateBookmark);
router.delete("/:id", controllersBookmarks.deleteBookmark);

export default router;
