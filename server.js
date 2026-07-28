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

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use(errorHandler);

// Without these, any stray error anywhere in the process (a socket.io handler,
// a timer, an unrelated route) crashes the entire server and drops every
// in-flight request — including unrelated ones like a login that was otherwise
// succeeding. Log and keep running instead.
process.on("uncaughtException", (err) => logger.error("uncaughtException:", err));
process.on("unhandledRejection", (err) => logger.error("unhandledRejection:", err));

const httpServer = createServer(app);
initSockets(httpServer);

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
