// @ts-check
// ── External error monitoring (PRD NFR-1) ───────────────────────────────────
//
// Until this, a failure in production was found only if someone read the log.
// Sentry receives the failures nobody is watching for: the unexpected 500, an
// unhandled rejection, a processing job that failed for good.
//
// Off unless SENTRY_DSN is set — a development machine, the tests and a fresh
// deployment send nothing, and every function here is then a no-op.
//
// NO PERSONAL DATA leaves this process. Sentry's SDK collects a great deal by
// default — request bodies, cookies, headers, the user, breadcrumbs of every
// log line and HTTP call — and this platform holds exactly what must not be
// sent: emails, password hashes, transcripts, the chat. So:
//
//   - no default integrations at all (initWithoutDefaultIntegrations), and no
//     OpenTelemetry setup: nothing is collected automatically, no request is
//     instrumented, no log line becomes a breadcrumb;
//   - only what captureError is handed is sent: the error, the service, the
//     request id that ties it to our own log, the method and the PATH (never
//     the query string, where user input lands);
//   - scrubEvent runs on every event before it is sent and removes anything
//     that could still carry a person: the user, the request, breadcrumbs, the
//     host name, and email addresses or tokens inside an error's message.
import * as Sentry from "@sentry/node";
import { logger } from "./logger.js";
import { env } from "./env.js";

let enabled = false;
let serviceName = "api";

// An address inside a message — pg's "Key (email)=(a@b.c) already exists" is
// the realistic case — or a JWT / bearer token pasted into one.
const EMAIL = /[^\s@"'()<>]+@[^\s@"'()<>]+\.[^\s@"'()<>]+/g;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const LONG_SECRET = /\b(sk|pk|rk|whsec)_(test|live)_[\w]+/g;

/** @param {string} text */
export const scrubText = (text) =>
  String(text ?? "")
    .replace(EMAIL, "[email]")
    .replace(JWT, "[token]")
    .replace(LONG_SECRET, "[key]");

/**
 * Strip an event down to what may leave the server. Exported for the tests.
 * @param {any} event
 */
export const scrubEvent = (event) => {
  if (!event) return event;
  delete event.user;
  delete event.request;
  delete event.server_name;
  delete event.contexts?.device;
  delete event.contexts?.culture;
  event.breadcrumbs = [];
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
  }
  if (event.message) event.message = scrubText(event.message);
  return event;
};

/**
 * Start reporting, if a DSN is configured. Call once per process, as early as
 * possible — server.js and each worker.
 * @param {string} service  "api", "transcription-worker", "llm-worker"
 */
export const initMonitoring = (service) => {
  serviceName = service;
  const dsn = env.sentryDsn;
  if (!dsn || enabled) return enabled;
  try {
    Sentry.initWithoutDefaultIntegrations({
      dsn,
      environment: env.sentryEnvironment,
      // Errors only: no performance tracing, which would record every request.
      tracesSampleRate: 0,
      enableOpenTelemetrySetup: false,
      maxBreadcrumbs: 0,
      beforeSend: (event) => scrubEvent(event),
      beforeBreadcrumb: () => null,
      initialScope: { tags: { service } },
    });
    enabled = true;
    logger.info(`[monitoring] errors are reported to Sentry (service ${service})`);
  } catch (err) {
    // Monitoring must never be the reason a process does not start.
    logger.error(`[monitoring] Sentry could not start — ${err.message}`);
  }
  return enabled;
};

export const monitoringEnabled = () => enabled;

/**
 * Report one error. Never throws, and does nothing when monitoring is off.
 * @param {unknown} err
 * @param {{ tags?: Record<string, string>, extra?: Record<string, unknown> }} [context]
 *   ids and names only — never a body, an email, or text a user wrote
 */
export const captureError = (err, context = {}) => {
  if (!enabled) return;
  try {
    Sentry.captureException(err, { tags: { service: serviceName, ...context.tags }, extra: context.extra });
  } catch {
    // Reporting a failure must not become a second one.
  }
};

/**
 * Send what is queued before the process exits. Resolves within `timeoutMs`
 * whatever happens.
 * @param {number} [timeoutMs]
 */
export const flushMonitoring = async (timeoutMs = 2000) => {
  if (!enabled) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Nothing to do: the process is going away.
  }
};
