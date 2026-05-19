import { Router } from "express";
import rateLimit from "express-rate-limit";
import passport from "../config/passport.js";
import { verifyToken } from "../middleware/auth.js";
import * as controllersAuth from "../controllers/controllersAuth.js";

const router = Router();

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts, please try again in a minute" },
});

router.post("/register", authLimiter, controllersAuth.register);
router.post("/login", authLimiter, controllersAuth.login);
router.post("/logout", verifyToken, controllersAuth.logout);
router.get("/me", verifyToken, controllersAuth.getMe);

router.get("/google", passport.authenticate("google", { scope: ["profile", "email"], session: false }));
router.get("/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: `${process.env.CLIENT_URL || "http://localhost:5173"}/sign-in?error=google_failed` }),
  controllersAuth.googleCallback
);

export default router;
