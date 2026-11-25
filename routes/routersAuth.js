// @ts-check
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import passport from "../config/passport.js";
import { verifyToken } from "../middleware/auth.js";
import * as controllersAuth from "../controllers/controllersAuth.js";
import * as controllersAvatars from "../controllers/controllersAvatars.js";
import * as controllersPhone from "../controllers/controllersPhone.js";
import multer from "multer";
import { userRateLimit } from "../middleware/userRateLimit.js";
import { validateIntParam } from "../middleware/validateIntParam.js";
import { AVATAR_MAX_BYTES } from "../services/servicesAvatars.js";
import { badRequest, ERROR_CODES } from "../lib/AppError.js";
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
// No verifyToken: clearing a cookie needs no authentication, and requiring it
// meant an expired or invalidated cookie answered 401 and was never cleared —
// the browser kept sending a dead token on every request.
router.post("/logout", controllersAuth.logout);
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

// The verification link again, for the signed-in user (UI_UX_FIXES 3.12). The
// recovery routes' allowance — five an hour — since each request is a real mail;
// counted per account rather than per address, because the caller is known and
// a yeshiva shares one IP. Mounted after verifyToken so req.user is the key.
const resendVerificationLimiter = userRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: "Too many requests, please try again later",
});
router.post("/resend-verification", verifyToken, resendVerificationLimiter, controllersAuth.resendVerification);

// The signed-in user's own account.
router.patch("/me", verifyToken, controllersAuth.updateProfile);

// A profile picture (migration 052). Held in memory: it is at most
// AVATAR_MAX_BYTES, and the client shrinks it to a few dozen kilobytes first.
// What the file IS is decided from its bytes in the controller
// (requireAvatarImage), not here from its name. multer reports a refused file
// through its own callback, so it is turned into an AppError on the way.
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: AVATAR_MAX_BYTES, files: 1 } });
const avatarLimiter = userRateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: "Too many picture changes, please wait a minute",
});
const receiveAvatar = (req, res, next) => {
  avatarUpload.single("avatar")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return next(badRequest("The picture is too large", ERROR_CODES.AVATAR_TOO_LARGE, {
        maxMb: AVATAR_MAX_BYTES / (1024 * 1024),
      }));
    }
    return next(badRequest(`Picture upload refused: ${err.message}`, ERROR_CODES.AVATAR_NOT_IMAGE));
  });
};
router.post("/me/avatar", verifyToken, avatarLimiter, receiveAvatar, controllersAvatars.uploadAvatar);
router.delete("/me/avatar", verifyToken, avatarLimiter, controllersAvatars.removeAvatar);
// Any signed-in user may see anyone's picture: it is shown beside their name.
router.get("/avatar/:id", verifyToken, validateIntParam("id"), controllersAvatars.getAvatar);
router.post("/change-password", verifyToken, authLimiter, controllersAuth.changePassword);

// A mobile number (migration 054, PRD AUTH-13). The real limits — one code a
// minute, three an hour per account and per number, five attempts per code —
// are in services/servicesPhone.js, where the number is known; this only stops
// a client looping.
const phoneLimiter = userRateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: "Too many requests, please wait a minute",
});
router.post("/me/phone", verifyToken, phoneLimiter, controllersPhone.startVerification);
router.post("/me/phone/verify", verifyToken, phoneLimiter, controllersPhone.verifyCode);
router.delete("/me/phone", verifyToken, phoneLimiter, controllersPhone.removePhone);

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

// Apple and LinkedIn (lib/oauthProviders.js). Apple returns with a form POST —
// the only way it will hand over the user's name and email — so that one
// callback, and nothing else here, parses a urlencoded body. Small, because
// all Apple sends is a code, a state, an id_token and the name.
router.get("/apple", controllersAuth.oauthStart("apple"));
router.post("/apple/callback",
  express.urlencoded({ extended: false, limit: "20kb" }),
  controllersAuth.oauthCallback("apple")
);
router.get("/linkedin", controllersAuth.oauthStart("linkedin"));
router.get("/linkedin/callback", controllersAuth.oauthCallback("linkedin"));

export default router;
