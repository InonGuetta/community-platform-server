import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { env } from "../lib/env.js";
import { serverSourceFiles } from "./sourceFiles.js";

// lib/env.js names every environment variable the server reads. These check
// that nothing else reads process.env, and that each getter keeps the default
// and the parsing of the line it replaced.

// Sets (or, for undefined, removes) the given variables for the length of fn,
// then puts back exactly what was there.
const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  const assign = (values) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  assign(vars);
  try {
    return fn();
  } finally {
    assign(saved);
  }
};

// ── Nobody else reads process.env ───────────────────────────────────────────

const READERS = new Set([path.join("lib", "env.js"), path.join("lib", "checkEnv.js")]);

// scripts/backupStatus.js quietens the logger for --json by SETTING LOG_LEVEL
// before it loads anything that logs. A write, and the one allowed.
const ALLOWED_LINES = new Map([
  [path.join("scripts", "backupStatus.js"), /process\.env\.LOG_LEVEL = "warn"/],
]);

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

test("only lib/env.js and lib/checkEnv.js read process.env", async () => {
  const files = await serverSourceFiles();
  assert.ok(files.length > 50, `only ${files.length} source files found`);
  const offending = [];
  for (const { file, source } of files) {
    if (READERS.has(file)) continue;
    source.split(/\r?\n/).forEach((line, i) => {
      if (!/process\.env\b/.test(line) || isComment(line)) return;
      if (ALLOWED_LINES.get(file)?.test(line)) return;
      offending.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offending, [], `read process.env through lib/env.js instead: ${offending.join(", ")}`);
});

// ── "Was it configured?" asks the raw values ────────────────────────────────

const S3 = { AWS_REGION: "eu-west-1", S3_BUCKET: "b", AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s" };

test("S3 counts as configured only with all four values supplied", () => {
  withEnv(S3, () => assert.equal(env.s3Configured, true));
  for (const name of Object.keys(S3)) {
    withEnv({ ...S3, [name]: undefined }, () => assert.equal(env.s3Configured, false, `without ${name}`));
  }
  // The region's default must not make an unset machine look configured.
  withEnv({ ...S3, AWS_REGION: undefined }, () => {
    assert.equal(env.awsRegion, "us-east-1");
    assert.equal(env.s3Configured, false);
  });
});

test("mail counts as configured only with host, port and sender supplied", () => {
  const smtp = { SMTP_HOST: "mail.example.test", SMTP_PORT: "465", MAIL_FROM: "x@example.test" };
  withEnv(smtp, () => {
    assert.equal(env.smtpConfigured, true);
    assert.equal(env.smtpPort, 465);
  });
  for (const name of Object.keys(smtp)) {
    withEnv({ ...smtp, [name]: undefined }, () => assert.equal(env.smtpConfigured, false, `without ${name}`));
  }
});

test("the Sentry DSN is trimmed, and the environment falls back to NODE_ENV, then development", () => {
  withEnv({ SENTRY_DSN: "  https://k@sentry.example.test/1 \n" }, () =>
    assert.equal(env.sentryDsn, "https://k@sentry.example.test/1"));
  withEnv({ SENTRY_DSN: undefined }, () => assert.equal(env.sentryDsn, undefined));
  withEnv({ SENTRY_ENVIRONMENT: " staging ", NODE_ENV: "production" }, () => assert.equal(env.sentryEnvironment, "staging"));
  withEnv({ SENTRY_ENVIRONMENT: "  ", NODE_ENV: "production" }, () => assert.equal(env.sentryEnvironment, "production"));
  withEnv({ SENTRY_ENVIRONMENT: undefined, NODE_ENV: undefined }, () => assert.equal(env.sentryEnvironment, "development"));
});

// ── Tuning knobs: `Number(value) || default`, as each call site had it ─────

const KNOBS = [
  ["JOB_TIMEOUT_MS", "jobTimeoutMs", 4 * 60 * 60 * 1000],
  ["LLM_ATTEMPTS", "llmAttempts", 3],
  ["TRANSCRIPTION_ATTEMPTS", "transcriptionAttempts", 1],
  ["WORKER_SHUTDOWN_GRACE_MS", "workerShutdownGraceMs", 10 * 60 * 1000],
  ["LLM_MAP_CONCURRENCY", "llmMapConcurrency", 3],
  ["MAX_RECONCILE_PER_RUN", "maxReconcilePerRun", 10],
];

for (const [name, getter, fallback] of KNOBS) {
  test(`${name}: a number when set, ${fallback} when unset, zero or not a number`, () => {
    withEnv({ [name]: "7" }, () => assert.equal(env[getter], 7));
    for (const value of [undefined, "", "0", "abc"]) {
      withEnv({ [name]: value }, () => assert.equal(env[getter], fallback, `for ${JSON.stringify(value)}`));
    }
  });
}

test("the port is the string given, or 3001", () => {
  withEnv({ PORT: "4000" }, () => assert.equal(env.port, "4000"));
  withEnv({ PORT: undefined }, () => assert.equal(env.port, 3001));
});

test("switches are on only for exactly \"true\"", () => {
  for (const [name, getter] of [["EXIT_ON_UNCAUGHT", "exitOnUncaught"], ["DATABASE_SSL_STRICT", "databaseSslStrict"]]) {
    withEnv({ [name]: "true" }, () => assert.equal(env[getter], true));
    for (const value of [undefined, "TRUE", "1", "yes"]) {
      withEnv({ [name]: value }, () => assert.equal(env[getter], false, `${name}=${value}`));
    }
  }
});

test("the seed script's admin has defaults for everything but the password", () => {
  withEnv({ SEED_ADMIN_EMAIL: undefined, SEED_ADMIN_NAME: undefined, SEED_ADMIN_PASSWORD: undefined }, () => {
    assert.equal(env.seedAdminEmail, "admin@community.local");
    assert.equal(env.seedAdminName, "Admin");
    assert.equal(env.seedAdminPassword, undefined);
  });
});

test("values are read on access, not at import", () => {
  withEnv({ LOG_LEVEL: "warn" }, () => assert.equal(env.logLevel, "warn"));
  withEnv({ LOG_LEVEL: "debug" }, () => assert.equal(env.logLevel, "debug"));
});
