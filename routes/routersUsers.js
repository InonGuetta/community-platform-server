import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import * as controllersUsers from "../controllers/controllersUsers.js";

const router = Router();

router.use(verifyToken, requireRole("admin"));

router.get("/get-all-users", controllersUsers.getAllUsers);
router.get("/:id", controllersUsers.getUserById);
router.post("/create-user", controllersUsers.createUser);
router.put("/update-user/:id", controllersUsers.updateUser);
router.delete("/delete-user/:id", controllersUsers.deleteUser);

export default router;
