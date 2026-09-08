// @ts-check
import { Router } from "express";
import rateLimit from "express-rate-limit";
import passport from "../config/passport.js";
import { verifyToken } from "../middleware/auth.js";
import * as controllersAuth from "../controllers/controllersAuth.js";
import { env } from "../lib/env.js";

const router = Router();

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts, please try again in a minute" },
});

// Account recovery is rate limited harder than signing in, and on a longer
// window. Each request here sends real mail to an address the caller chose, so an
// unbounded one is both a way to flood somebody's inbox and a way to spend the
// mail provider's quota — neither of which the login limiter's per-minute
// allowance is shaped for. The confirm side shares it because a reset token is
// 32 random bytes and guessing at five attempts an hour is not a threat worth
// separating out.
const recoveryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later" },
});

const roleRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later" },
});

router.post("/register", authLimiter, controllersAuth.register);
router.post("/login", authLimiter, controllersAuth.login);
router.post("/logout", verifyToken, controllersAuth.logout);
router.get("/me", verifyToken, controllersAuth.getMe);

// Public by necessity: somebody who cannot sign in is the only person who ever
// needs these. Neither reveals whether an address has an account — see
// controllersAuth.forgotPassword for why that matters.
router.post("/forgot-password", recoveryLimiter, controllersAuth.forgotPassword);
router.post("/reset-password", recoveryLimiter, controllersAuth.resetPassword);
// Also public: the link is followed from an inbox, and requiring a session first
// would break the one case it exists for — a new account on a different device.
// The token in the body is the credential.
router.post("/verify-email", recoveryLimiter, controllersAuth.verifyEmail);

// The signed-in user's own account.
router.patch("/me", verifyToken, controllersAuth.updateProfile);
router.post("/change-password", verifyToken, authLimiter, controllersAuth.changePassword);

// Asking for a lecturer or admin role after registration — the path a Google
// sign-in has to use, since the OAuth callback never shows the signup form, and
// the path a long-standing student uses when they start giving a shiur.
//
// Its OWN limiter rather than authLimiter, and the reason is the shared bucket:
// authLimiter counts login and register together at ten a minute, so putting
// this on it would let a role request contribute to locking somebody out of
// SIGNING IN — two unrelated actions competing for one allowance. The real
// throttle here is the seven-day cooldown in the service; this only stops a
// client looping, so it is deliberately generous.
router.post("/request-role", verifyToken, roleRequestLimiter, controllersAuth.requestRole);

router.get("/google", passport.authenticate("google", { scope: ["profile", "email"], session: false }));
router.get("/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: `${env.clientUrl}/sign-in?error=google_failed` }),
  controllersAuth.googleCallback
);

export default router;
