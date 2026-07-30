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
import { logger } from "./logger.js";
import { requireEnv, warnMissingEnv } from "./env.js";

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
  CLIENT_URL: "falling back to http://localhost:5173 for CORS and OAuth redirects",
});

// Mirrors s3Configured() in lib/storage.js — all four are needed before uploads
// go to S3 rather than the local uploads/ directory.
const S3_VARS = ["AWS_REGION", "S3_BUCKET", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
const missingS3 = S3_VARS.filter((name) => !process.env[name]?.trim());
if (missingS3.length > 0) {
  logger.warn(`S3 not configured (missing ${missingS3.join(", ")}) — uploads will be stored on local disk`);
}
