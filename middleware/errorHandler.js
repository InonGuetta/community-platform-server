import { logger } from "../lib/logger.js";

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

const isDbConnError = (err) =>
  DB_CONN_CODES.has(err?.code) ||
  /Connection terminated|timeout expired|read ECONNRESET/i.test(err?.message || "");

export const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  // Operational errors (AppError) carry a client-safe message + status. Anything
  // else is unexpected: log the stack, return a generic message, and only reveal
  // the real message outside production.
  if (err?.expose && err.statusCode) {
    return res.status(err.statusCode).json({ message: err.message });
  }

  if (isDbConnError(err)) {
    logger.warn(`DB connection error on ${req.method} ${req.originalUrl}: ${err.message}`);
    return res.status(503).json({ message: "Database temporarily unavailable, please retry" });
  }

  logger.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err.stack || err);

  const body = { message: "Internal server error" };
  if (process.env.NODE_ENV !== "production") body.error = err.message;
  res.status(500).json(body);
};
