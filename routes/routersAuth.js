import { Router } from "express";
import passport from "../config/passport.js";
import { verifyToken } from "../middleware/auth.js";
import * as controllersAuth from "../controllers/controllersAuth.js";

const router = Router();

router.post("/register", controllersAuth.register);
router.post("/login", controllersAuth.login);
router.post("/logout", verifyToken, controllersAuth.logout);
router.get("/me", verifyToken, controllersAuth.getMe);

router.get("/google", passport.authenticate("google", { scope: ["profile", "email"], session: false }));
router.get("/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: `${process.env.CLIENT_URL || "http://localhost:5173"}/sign-in?error=google_failed` }),
  controllersAuth.googleCallback
);

export default router;
