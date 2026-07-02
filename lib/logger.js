// Minimal levelled logger. Replaces scattered console.* calls so verbosity is
// controllable: set LOG_LEVEL=error|warn|info|debug. Defaults to "info" in
// production (the noisy step-by-step traces are debug and stay silent there) and
// "debug" everywhere else. Never log PII (emails, full search queries) — log
// identifiers/lengths instead.
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const configured = LEVELS[process.env.LOG_LEVEL];
const current = configured !== undefined
  ? configured
  : (process.env.NODE_ENV === "production" ? LEVELS.info : LEVELS.debug);

const emit = (level, sink) => (...args) => {
  if (LEVELS[level] <= current) sink(`[${new Date().toISOString()}] [${level.toUpperCase()}]`, ...args);
};

export const logger = {
  error: emit("error", console.error),
  warn: emit("warn", console.warn),
  info: emit("info", console.log),
  debug: emit("debug", console.log),
};
