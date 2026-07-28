import "dotenv/config";
// Must stay directly after dotenv/config and above every other import — see the
// header of lib/checkEnv.js for why the position is load-bearing.
import "./lib/checkEnv.js";
import express from "express";
import { createServer } from "http";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import passport from "./config/passport.js";
import { pool } from "./db/pool.js";
import { transcriptionQueue } from "./queue/transcriptionQueue.js";
import { llmQueue } from "./queue/llmQueue.js";
import { initSockets } from "./sockets/socketManager.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { logger } from "./lib/logger.js";
import routersAuth from "./routes/routersAuth.js";
import routersUsers from "./routes/routersUsers.js";
import routersMedia from "./routes/routersMedia.js";
import routersSessions from "./routes/routersSessions.js";
import routersTranscripts from "./routes/routersTranscripts.js";
import routersBookmarks from "./routes/routersBookmarks.js";
import routersNotes from "./routes/routersNotes.js";
import routersDonations from "./routes/routersDonations.js";
import routersAdmin from "./routes/routersAdmin.js";

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:5173", credentials: true }));

// Stripe verifies the webhook signature against the raw request body, so it must
// NOT be JSON-parsed. Skip the global parser for that one route; the donations
// router re-parses it with express.raw(). Every other route still gets JSON.
//
// limit: a saved transcript carries the full edited text in the body. A multi-hour
// Hebrew lecture is hundreds of KB (UTF-8 Hebrew is ~2 bytes/char), well past the
// 100KB body-parser default — which silently rejected the PUT with 413 and lost
// the edit. 20mb leaves ample headroom for any realistic transcript.
const jsonParser = express.json({ limit: "20mb" });
app.use((req, res, next) => {
  if (req.originalUrl === "/api/donations/webhook") return next();
  jsonParser(req, res, next);
});

app.use(cookieParser());
app.use(passport.initialize());

app.use("/api/auth", routersAuth);
app.use("/api/users", routersUsers);
app.use("/api/media", routersMedia);
app.use("/api/sessions", routersSessions);
app.use("/api/transcripts", routersTranscripts);
app.use("/api/bookmarks", routersBookmarks);
app.use("/api/notes", routersNotes);
app.use("/api/donations", routersDonations);
app.use("/api/admin", routersAdmin);

// Unauthenticated by design — a probe has to reach it. So it reports only
// whether the service is usable: the raw driver message used to go out with it,
// which tells an anonymous caller about the database behind this.
// 503 rather than 500, matching how errorHandler classifies a dependency that
// is unreachable rather than a fault in the request.
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    logger.error(`[health] database check failed: ${err.message}`);
    res.status(503).json({ ok: false });
  }
});

app.use(errorHandler);

const httpServer = createServer(app);
const io = initSockets(httpServer);

// ── Shutdown ────────────────────────────────────────────────────────────────
// Close in dependency order so in-flight work can finish: stop accepting new
// connections and let the open ones drain, drop the websockets, then release
// the DB pool. The workers run as separate processes with their own pools, so
// they are unaffected.
const SHUTDOWN_TIMEOUT_MS = 10000;
let shuttingDown = false;

const shutdown = async (reason, exitCode) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Shutting down (${reason})...`);

  // Backstop: a connection that refuses to close must not keep the process
  // alive forever and block the restart behind it.
  const forceExit = setTimeout(() => {
    logger.error(`Shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`);
    httpServer.closeAllConnections?.();
    process.exit(exitCode);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    const closed = new Promise((resolve) => httpServer.close(resolve));
    // keepAliveTimeout is 65s, so idle pooled connections would otherwise hold
    // the server open until the timer above fires on every single restart.
    httpServer.closeIdleConnections?.();
    await closed;

    io.close();
    // This process only ever *adds* jobs (it runs no processor), so there is
    // nothing in flight to drain — these are just the Redis connections the
    // admin queue-stats endpoint uses.
    await Promise.all([transcriptionQueue.close(), llmQueue.close()]);
    await pool.end();
    logger.info("Shutdown complete");
  } catch (err) {
    logger.error(`Error during shutdown: ${err.message}`);
  }

  clearTimeout(forceExit);
  process.exit(exitCode);
};

// Without this, every deploy / `docker stop` / pm2 reload kills the process
// mid-request and drops whatever was in flight.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => shutdown(signal, 0));
}

// An unhandled rejection is usually one broken path rather than a poisoned
// process, so it is logged (with the stack) and the server keeps serving.
process.on("unhandledRejection", (err) => logger.error("unhandledRejection:", err?.stack || err));

// After an uncaughtException the process state is undefined, so the correct
// move is to shut down and let a supervisor start a clean one. That is only an
// improvement if something actually restarts us — otherwise the server simply
// stays dead — so it is opt-in: set EXIT_ON_UNCAUGHT=true once the app runs
// under pm2 / systemd / Docker with a restart backoff. Until then we log and
// keep running, exactly as before.
const EXIT_ON_UNCAUGHT = process.env.EXIT_ON_UNCAUGHT === "true";
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException:", err?.stack || err);
  if (EXIT_ON_UNCAUGHT) shutdown("uncaughtException", 1);
});

// Warm the pg pool before traffic arrives so the SSL handshake / cold
// Supabase connection happens on boot — not on the user's first login,
// where it manifested as ECONNRESET on /api/auth/login.
pool.query("SELECT 1").catch((err) =>
  logger.error("[pg pool] warmup failed:", err.message)
);

const PORT = process.env.PORT || 3001;

// On Windows, `node --watch` can start the new process before the previous
// one has released the port, so the fresh process hits EADDRINUSE and (being
// an unhandled 'error' event) crashes outright instead of retrying — dropping
// any request that was in flight during the restart. Retry the bind instead.
httpServer.on("error", (err) => {
  if (shuttingDown) return;
  if (err.code === "EADDRINUSE") {
    logger.warn(`Port ${PORT} still in use, retrying in 500ms...`);
    setTimeout(() => httpServer.listen(PORT), 500);
  } else {
    logger.error("HTTP server error:", err);
  }
});

// Node's default keepAliveTimeout (5s) is shorter than the idle gap a real user
// leaves between requests (typing a password, thinking). When that timer fires,
// this server closes the socket; the Vite dev proxy's pooled connection doesn't
// find out until it tries to reuse it, and the write lands on a dead socket as
// ECONNRESET — surfaced to the browser as a 500 on an otherwise-fine request.
// headersTimeout must stay above keepAliveTimeout or Node throws at startup.
httpServer.keepAliveTimeout = 65000;
httpServer.headersTimeout = 66000;

httpServer.listen(PORT, () => logger.info(`Server on port ${PORT}`));
