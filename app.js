// @ts-check
// The Express application, with no process lifecycle attached.
//
// Split out of server.js so the tests can drive the real middleware chain —
// helmet, the body parsers, cookie-parser, passport, every router and the error
// handler, in the order production uses them — without opening a port, a socket
// server, a queue connection or a signal handler. server.js is now only the
// things that own the process: listening, sockets, shutdown.
//
// Deliberately does NOT import lib/checkEnv.js. That check belongs to booting a
// real server (see its header for why its position in server.js is load-
// bearing); a test supplies its own placeholder environment and must not be
// required to satisfy a production configuration to exercise a route.
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import passport from "./config/passport.js";
import { databaseReachable } from "./services/servicesHealth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { logger } from "./lib/logger.js";
import { env } from "./lib/env.js";
import routersAuth from "./routes/routersAuth.js";
import routersUsers from "./routes/routersUsers.js";
import routersMedia from "./routes/routersMedia.js";
import routersCourses from "./routes/routersCourses.js";
import routersSessions from "./routes/routersSessions.js";
import routersTranscripts from "./routes/routersTranscripts.js";
import routersBookmarks from "./routes/routersBookmarks.js";
import routersNotes from "./routes/routersNotes.js";
import routersLikes from "./routes/routersLikes.js";
import routersDonations from "./routes/routersDonations.js";
import routersAdmin from "./routes/routersAdmin.js";

// Every resource, and the prefix it is mounted at. Exported because the route
// tests walk it: a new resource added here is automatically included in the
// "nothing is reachable without authentication" sweep, so a router that forgets
// verifyToken cannot slip in unnoticed.
//
// The annotation makes these pairs rather than a loose array — without it the
// entries widen to `string | Router` and destructuring below loses which is
// which, so a reversed pair would only be caught at runtime.
/** @type {Array<[string, import("express").Router]>} */
export const API_ROUTERS = [
  ["/api/auth", routersAuth],
  ["/api/users", routersUsers],
  ["/api/media", routersMedia],
  ["/api/courses", routersCourses],
  ["/api/sessions", routersSessions],
  ["/api/transcripts", routersTranscripts],
  ["/api/bookmarks", routersBookmarks],
  ["/api/notes", routersNotes],
  ["/api/likes", routersLikes],
  ["/api/donations", routersDonations],
  ["/api/admin", routersAdmin],
];

export const createApp = () => {
  const app = express();

  // First in the chain on purpose: it opens the request-id scope that every log
  // line below inherits, and a request rejected by helmet or cors should still
  // appear in the log rather than vanish.
  app.use(requestLogger);

  app.use(helmet());

  // exposedHeaders is what lets the BROWSER read X-Request-Id. A response
  // header set cross-origin is invisible to JavaScript unless it is named here
  // — only a short safelist (Content-Type, Cache-Control, …) is readable by
  // default. Without it the client's api logging prints its line with no id,
  // and the whole point of the id (matching a failure the user is looking at to
  // the server log that explains it) quietly stops working.
  //
  // This did not show up in development because Vite proxies /api, which makes
  // every request same-origin — where the rule does not apply. It would have
  // broken the first time the client was served from a different origin.
  app.use(cors({
    origin: env.clientUrl,
    credentials: true,
    exposedHeaders: ["X-Request-Id"],
  }));

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

  for (const [prefix, router] of API_ROUTERS) app.use(prefix, router);

  // Unauthenticated by design — a probe has to reach it. So it reports only
  // whether the service is usable: the raw driver message used to go out with it,
  // which tells an anonymous caller about the database behind this.
  // 503 rather than 500, matching how errorHandler classifies a dependency that
  // is unreachable rather than a fault in the request.
  app.get("/health", async (req, res) => {
    try {
      await databaseReachable();
      res.json({ ok: true });
    } catch (err) {
      logger.error(`[health] database check failed: ${err.message}`);
      res.status(503).json({ ok: false });
    }
  });

  app.use(errorHandler);

  return app;
};
