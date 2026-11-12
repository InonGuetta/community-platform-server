// @ts-check
// Side-effect module: validates the environment before anything else reads it.
//
// Ordering matters. ES imports are evaluated in source order, and several
// modules read process.env at import time — the pg pool, the Bull queues, the
// passport strategy, the Stripe and OpenAI clients — each throwing its own
// partial, cryptic error for whichever variable it happens to need first.
// Importing this file directly after "dotenv/config" in server.js turns that
// into one clear message listing everything that's missing. Keep it second;
// moving it below the other imports silently defeats it.
//
// JWT_SECRET is the one that matters most here: nothing reads it at import
// time, so without this check the server boots happily and every login and
// every authenticated request fails with a 500 at runtime instead.
//
// The variables are named and parsed in lib/env.js; this file asks only
// whether they are present, and is the one other module that reads
// process.env, by name.
import { logger } from "./logger.js";

const isBlank = (name) => !process.env[name]?.trim();

// Fail fast, and fail ONCE: report every missing variable together so a fresh
// setup is fixed in a single pass instead of one reboot per variable.
const requireEnv = (names) => {
  const missing = names.filter(isBlank);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
      `Copy .env.example to .env and fill them in.`
    );
  }
};

// Not fatal, but the feature each one powers is silently degraded. Say so at
// boot instead of letting it surface later as a confusing runtime failure.
const warnMissingEnv = (consequenceByName) => {
  for (const [name, consequence] of Object.entries(consequenceByName)) {
    if (isBlank(name)) logger.warn(`${name} is not set — ${consequence}`);
  }
};

requireEnv([
  "DATABASE_URL",
  "JWT_SECRET",
  "REDIS_URL",
  "OPENAI_API_KEY",
  "STRIPE_SECRET_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
]);

warnMissingEnv({
  STRIPE_WEBHOOK_SECRET: "donation webhooks will be rejected as unverified",
  SENTRY_DSN: "errors are not reported anywhere but this log (PRD NFR-1)",
  CLIENT_URL: "falling back to http://localhost:5173 for CORS and OAuth redirects",
});

// Mail is a warning rather than a requirement, and the line says what breaks
// because the consequence is not obvious: without it a user who forgets their
// password has NO way back into their account. Not fatal, because a development
// machine has no SMTP and the rest of the application works fine without it —
// lib/mailer.js logs the message body instead so the flow can still be followed.
const SMTP_VARS = ["SMTP_HOST", "SMTP_PORT", "MAIL_FROM"];
const missingSmtp = SMTP_VARS.filter(isBlank);
if (missingSmtp.length > 0) {
  logger.warn(
    `Mail not configured (missing ${missingSmtp.join(", ")}) — password reset and ` +
    `email verification links will be written to this log instead of sent`
  );
}

// Mirrors env.s3Configured in lib/env.js — all four are needed before uploads
// go to S3 rather than the local uploads/ directory.
const S3_VARS = ["AWS_REGION", "S3_BUCKET", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
const missingS3 = S3_VARS.filter(isBlank);
if (missingS3.length > 0) {
  logger.warn(`S3 not configured (missing ${missingS3.join(", ")}) — uploads will be stored on local disk`);
}
