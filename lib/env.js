// @ts-check
import { logger } from "./logger.js";

const isBlank = (name) => !process.env[name]?.trim();

// Fail fast, and fail ONCE: report every missing variable together so a fresh
// setup is fixed in a single pass instead of one reboot per variable.
export const requireEnv = (names) => {
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
export const warnMissingEnv = (consequenceByName) => {
  for (const [name, consequence] of Object.entries(consequenceByName)) {
    if (isBlank(name)) logger.warn(`${name} is not set — ${consequence}`);
  }
};

// ── Named access to the variables that are read from more than one file ──────
//
// Two problems this solves, both of which had already happened here:
//
//   1. A default duplicated per call site drifts. "http://localhost:5173" was
//      written out separately in server.js (CORS), socketManager.js (socket
//      CORS), routersAuth.js and controllersAuth.js (OAuth redirects). Changing
//      the dev port meant finding all four, and missing one produces a failure
//      that only shows up in the browser as a blocked request.
//   2. A variable read as `process.env.X` straight from a controller bypasses
//      checkEnv.js entirely, so a missing value is discovered by a user mid-
//      upload instead of at boot. S3_BUCKET was read that way in five places.
//
// Getters, not captured constants: several modules are imported before
// dotenv/config has finished in some entry points (the workers, the test setup
// that assigns placeholders), and a captured value would freeze whatever was
// there at import time. Reading on access makes the import order irrelevant.
export const env = {
  get clientUrl() { return process.env.CLIENT_URL || "http://localhost:5173"; },
  get jwtSecret() { return process.env.JWT_SECRET; },
  get isProduction() { return process.env.NODE_ENV === "production"; },

  // S3. awsRegion carries the same default the S3 client was constructed with.
  get s3Bucket() { return process.env.S3_BUCKET; },
  get awsRegion() { return process.env.AWS_REGION || "us-east-1"; },
};
