import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import * as controllersNotes from "../controllers/controllersNotes.js";

const router = Router();

router.use(verifyToken);

router.get("/", controllersNotes.getNotes);
router.post("/", controllersNotes.createNote);
router.put("/:id", controllersNotes.updateNote);
router.delete("/:id", controllersNotes.deleteNote);

export default router;
