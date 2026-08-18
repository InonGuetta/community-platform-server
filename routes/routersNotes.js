// @ts-check
import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import { validateIntParam } from "../middleware/validateIntParam.js";
import * as controllersNotes from "../controllers/controllersNotes.js";

const router = Router();

router.use(verifyToken);

router.get("/", controllersNotes.getNotes);
router.post("/", controllersNotes.createNote);

// BEFORE "/:id", and it has to stay there: Express matches in the order routes
// are declared, so with these two the other way round "order" is read as an id
// and validateIntParam answers 400 to every reorder.
router.put("/order", controllersNotes.reorderNotes);

router.put("/:id", validateIntParam("id"), controllersNotes.updateNote);
router.delete("/:id", validateIntParam("id"), controllersNotes.deleteNote);

export default router;
