// @ts-check
// Minimal levelled logger. Replaces scattered console.* calls so verbosity is
// controllable: set LOG_LEVEL=error|warn|info|debug. Defaults to "info" in
// production (the noisy step-by-step traces are debug and stay silent there) and
// "debug" everywhere else. Never log PII (emails, full search queries) — log
// identifiers/lengths instead.
//
// Every line is stamped with the id of the request that produced it, when there
// is one (see lib/requestContext.js). That id also goes back to the browser in
// the X-Request-Id header, so a failure a user reports can be traced to the
// exact request, its SQL and its socket traffic without guessing from timestamps.
import { getRequestId } from "./requestContext.js";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const configured = LEVELS[process.env.LOG_LEVEL];
const current = configured !== undefined
  ? configured
  : (process.env.NODE_ENV === "production" ? LEVELS.info : LEVELS.debug);

// Read at call time rather than captured: workers and scripts never have one,
// and a request's id only exists once it is in flight.
const requestTag = () => {
  const id = getRequestId();
  return id ? ` [${id}]` : "";
};

const emit = (level, sink) => (...args) => {
  if (LEVELS[level] <= current) {
    sink(`[${new Date().toISOString()}] [${level.toUpperCase()}]${requestTag()}`, ...args);
  }
};

export const logger = {
  error: emit("error", console.error),
  warn: emit("warn", console.warn),
  info: emit("info", console.log),
  debug: emit("debug", console.log),
};

// True when the configured level would actually print a debug line. Lets a
// caller skip building an expensive message (serialising a payload, measuring a
// body) that would only be thrown away.
export const debugEnabled = () => LEVELS.debug <= current;
