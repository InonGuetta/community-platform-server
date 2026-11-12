// @ts-check
// Every environment variable the server reads, by name, in one place.
//
// Open this file to see what a deployment can configure, what each value
// defaults to and how it is parsed. Which of them must be present before the
// server boots is lib/checkEnv.js's business; this file only names them.
// test/envAccess.test.js fails if any other module reads process.env itself.
//
// Why one place: a default written out per call site drifts. The client URL
// "http://localhost:5173" was once spelled out separately for CORS, socket CORS
// and two OAuth redirects, and changing the dev port meant finding all four —
// missing one shows up only in the browser, as a blocked request. And a value
// read straight from a controller is invisible to whoever is working out what
// a deployment needs.
//
// No imports, deliberately. lib/logger.js reads its level from here, and the
// logger is imported by nearly everything, lib/checkEnv.js included; a module
// with no dependencies cannot be part of an import cycle.
//
// Getters, not captured constants: several modules are imported before
// dotenv/config has finished in some entry points (the workers, the test setup
// that assigns placeholders), and a captured value would freeze whatever was
// there at import time. Reading on access makes the import order irrelevant. A
// module that wants a value fixed for its lifetime — the queue attempts, the
// worker grace period — captures it itself, at module level.
export const env = {
  // ── Core ──────────────────────────────────────────────────────────────────
  get databaseUrl() { return process.env.DATABASE_URL; },
  // Verify the database's TLS certificate. Off unless exactly "true" — see the
  // comment in db/pool.js for why that is the default.
  get databaseSslStrict() { return process.env.DATABASE_SSL_STRICT === "true"; },
  get redisUrl() { return process.env.REDIS_URL; },
  get jwtSecret() { return process.env.JWT_SECRET; },
  get openaiApiKey() { return process.env.OPENAI_API_KEY; },
  get clientUrl() { return process.env.CLIENT_URL || "http://localhost:5173"; },
  get isProduction() { return process.env.NODE_ENV === "production"; },
  // The string as given when set (Node's listen() takes one), 3001 otherwise.
  get port() { return process.env.PORT || 3001; },
  // Exit after an uncaughtException so a supervisor restarts the process.
  // Only exactly "true" — see server.js for why it is opt-in.
  get exitOnUncaught() { return process.env.EXIT_ON_UNCAUGHT === "true"; },
  // error | warn | info | debug, as typed. lib/logger.js chooses by NODE_ENV
  // when it is unset or not one of the four.
  get logLevel() { return process.env.LOG_LEVEL; },

  // Default matches the previous hard-coded value (2GB).
  get maxUploadBytes() { return Number(process.env.MAX_UPLOAD_BYTES) || 2 * 1024 * 1024 * 1024; },

  // How many proxies sit in front of the API. Unset (or 0) means none, which is
  // the safe default: trusting X-Forwarded-For without a proxy lets any client
  // pick its own rate-limit bucket. Behind one nginx / load balancer, set 1.
  get trustProxy() {
    const hops = Number(process.env.TRUST_PROXY);
    return Number.isInteger(hops) && hops > 0 ? hops : false;
  },

  // ── Optional integrations, and whether each one was configured ────────────
  //
  // "Configured" is asked of the RAW values, never of the getters below that
  // carry a default: awsRegion falls back to us-east-1, so asking it would
  // report S3 as configured on a machine with nothing set, and uploads would be
  // attempted against a bucket that is undefined. Mail likewise — it would then
  // fail per message, at the worst possible moment. Truthiness, not trimming,
  // exactly as lib/storage.js and lib/mailer.js have always asked.

  // All four are needed before uploads go to S3 rather than local disk. The
  // SDK reads the two keys from the environment itself; only their presence is
  // asked here.
  get s3Configured() {
    return Boolean(
      process.env.AWS_REGION &&
      process.env.S3_BUCKET &&
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY
    );
  },
  get s3Bucket() { return process.env.S3_BUCKET; },
  // The region the S3 client is constructed with.
  get awsRegion() { return process.env.AWS_REGION || "us-east-1"; },

  // Without these three, mail is written to the log instead (lib/mailer.js).
  get smtpConfigured() {
    return Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.MAIL_FROM);
  },
  get smtpHost() { return process.env.SMTP_HOST; },
  get smtpPort() { return Number(process.env.SMTP_PORT); },
  // Optional: a local relay often has no login.
  get smtpUser() { return process.env.SMTP_USER; },
  get smtpPassword() { return process.env.SMTP_PASSWORD; },
  get mailFrom() { return process.env.MAIL_FROM; },

  // External error reporting (PRD NFR-1; lib/monitoring.js). Off while the DSN
  // is unset or blank.
  get sentryDsn() { return process.env.SENTRY_DSN?.trim(); },
  get sentryEnvironment() {
    return process.env.SENTRY_ENVIRONMENT?.trim() || process.env.NODE_ENV || "development";
  },

  // Stripe. A payment secret is exactly the class of variable checkEnv.js
  // exists for: a deployment missing it must fail at startup, not at the first
  // donation.
  get stripeSecretKey() { return process.env.STRIPE_SECRET_KEY; },
  get stripeWebhookSecret() { return process.env.STRIPE_WEBHOOK_SECRET; },
  // The PUBLIC half of the Stripe pair (pk_test_… / pk_live_…). Handed to the
  // browser with each payment, so the two keys are set in one file — this one.
  get stripePublishableKey() { return process.env.STRIPE_PUBLISHABLE_KEY || ""; },

  // Google OAuth (config/passport.js).
  get googleClientId() { return process.env.GOOGLE_CLIENT_ID; },
  get googleClientSecret() { return process.env.GOOGLE_CLIENT_SECRET; },

  // The monthly OpenAI spend, in US dollars, past which NEW processing is
  // refused (PRD NFR-3; services/servicesAiUsage.js). Unset, empty or not a positive number
  // means no cap — the platform behaves exactly as it did before there was one.
  get aiMonthlyCapUsd() {
    const cap = Number(process.env.AI_MONTHLY_CAP_USD);
    return Number.isFinite(cap) && cap > 0 ? cap : null;
  },

  // ── Queues and workers ────────────────────────────────────────────────────
  //
  // Tuning knobs. Each falls back to its default when unset, zero or not a
  // number. Why each default is what it is lives beside the code that uses it.

  // queue/createQueue.js — the backstop for a job that is genuinely wedged.
  get jobTimeoutMs() { return Number(process.env.JOB_TIMEOUT_MS) || 4 * 60 * 60 * 1000; },
  // queue/llmQueue.js — summaries are cheap and idempotent, so they retry.
  get llmAttempts() { return Number(process.env.LLM_ATTEMPTS) || 3; },
  // queue/transcriptionQueue.js — a retry re-bills every Whisper call, so none.
  get transcriptionAttempts() { return Number(process.env.TRANSCRIPTION_ATTEMPTS) || 1; },
  // queue/workers/workerLifecycle.js — how long a stopping worker lets its job finish.
  get workerShutdownGraceMs() { return Number(process.env.WORKER_SHUTDOWN_GRACE_MS) || 10 * 60 * 1000; },
  // services/transcripts/analysis.js — summary map calls in flight at once.
  get llmMapConcurrency() { return Number(process.env.LLM_MAP_CONCURRENCY) || 3; },
  // services/transcripts/pipeline.js — stranded recordings queued per reconcile.
  get maxReconcilePerRun() { return Number(process.env.MAX_RECONCILE_PER_RUN) || 10; },

  // ── Scripts ───────────────────────────────────────────────────────────────

  // db/seed.js — the first admin of a fresh install.
  get seedAdminEmail() { return process.env.SEED_ADMIN_EMAIL || "admin@community.local"; },
  get seedAdminPassword() { return process.env.SEED_ADMIN_PASSWORD; },
  get seedAdminName() { return process.env.SEED_ADMIN_NAME || "Admin"; },
};
