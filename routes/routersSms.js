// @ts-check
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import * as controllersSms from "../controllers/controllersSms.js";

// The SMS provider calling back (PRD AUTH-13). No verifyToken: Twilio calls it
// server to server, with no cookie, and authenticates by signature instead —
// which the controller checks before reading anything (lib/sms.js →
// verifyTwilioSignature). Twilio posts a form, so this route, and only this
// one, parses a small urlencoded body.
const router = Router();

const inboundLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests" },
});

router.post(
  "/inbound",
  inboundLimiter,
  express.urlencoded({ extended: false, limit: "20kb" }),
  controllersSms.inbound
);

export default router;
