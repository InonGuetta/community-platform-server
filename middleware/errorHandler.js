// @ts-check
import { logger } from "../lib/logger.js";
import { ERROR_CODES } from "../lib/AppError.js";
import { env } from "../lib/env.js";

// Postgres SQLSTATEs / Node errno codes that indicate the DB connection
// itself died (idle drop, cold pool, network reset). Surfacing these as
// 503 lets the client retry instead of treating it like a logic bug.
const DB_CONN_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000", "08003", "08006", "08001", "08004", // connection_exception family
]);

// pg reports the timeouts configured in db/pool.js as plain Errors with no
// `code`, so only the message identifies them — and each layer words it
// differently. Matching on the wrong wording is not a cosmetic miss: it drops
// the error through to the generic branch, which answers 500. The client treats
// a 500 as "the server processed this and failed" and does not retry it, so a
// merely cold database connection became a dead end the user had to click
// through. Every string below is quoted from pg/pg-pool.
const DB_CONN_MESSAGES = [
  /Connection terminated/i,                    // pg: socket ended, incl. "due to connection timeout"
  /timeout expired/i,                          // pg: connectionTimeoutMillis, client level
  /timeout exceeded when trying to connect/i,  // pg-pool: no client free within connectionTimeoutMillis
  /Query read timeout/i,                       // pg: query_timeout fired
  /is not queryable/i,                         // pg: the pooled client died before the query was sent
  /read ECONNRESET/i,
];

const isDbConnError = (err) =>
  DB_CONN_CODES.has(err?.code) ||
  DB_CONN_MESSAGES.some((pattern) => pattern.test(err?.message || ""));

export const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  // Operational errors (AppError) carry a client-safe message + status. Anything
  // else is unexpected: log the stack, return a generic message, and only reveal
  // the real message outside production.
  if (err?.expose && err.statusCode) {
    // `code` is spread in only when present, so an AppError constructed without
    // one still answers exactly the body it always did.
    return res.status(err.statusCode).json({
      message: err.message,
      ...(err.code && { code: err.code }),
    });
  }

  if (isDbConnError(err)) {
    logger.warn(`DB connection error on ${req.method} ${req.path}: ${err.message}`);
    return res.status(503).json({
      message: "Database temporarily unavailable, please retry",
      code: ERROR_CODES.DB_UNAVAILABLE,
    });
  }

  // req.path rather than originalUrl: the query string is where user input
  // lands (?search=…, ?code=… on the OAuth callback), and this line goes to the
  // log at error level where it is kept the longest.
  logger.error(`Unhandled error on ${req.method} ${req.path}:`, err.stack || err);

  const body = { message: "Internal server error", code: ERROR_CODES.INTERNAL };
  if (!env.isProduction) body.error = err.message;
  res.status(500).json(body);
};
