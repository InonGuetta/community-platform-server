// @ts-check
import { randomUUID } from "crypto";
import { logger } from "../lib/logger.js";
import { runWithRequestId } from "../lib/requestContext.js";

// One line per HTTP request, plus the id that ties it to everything it caused.
//
// What gets logged is deliberately narrow. The logger's own rule is "never log
// PII", and a URL is where PII hides in this app: /api/media?search=<what the
// user typed> and the OAuth callback's ?code=<credential> both carry it. So the
// path is logged and the query string is reduced to its KEY NAMES — enough to
// know a search happened and which filters were used, without recording what was
// searched for.
const summariseQuery = (query) => {
  const keys = Object.keys(query || {});
  return keys.length ? ` ?${keys.join(",")}` : "";
};

// A short slice of a UUID. Collisions do not matter here — the id only has to be
// unique among the requests in flight at once, and 8 hex characters are far
// easier to quote in a bug report than a full UUID.
const newRequestId = () => randomUUID().slice(0, 8);

// Probes hit this every few seconds and there is nothing to learn from a
// successful one; the failure path already logs for itself in server.js.
const SKIP_PATHS = new Set(["/health"]);

const levelFor = (status) => {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  // A 206 is one chunk of a media file. A single scrub of the player fires a
  // burst of these, so they stay at debug — otherwise normal playback buries
  // every other line in the log.
  if (status === 206) return "debug";
  return "info";
};

export const requestLogger = (req, res, next) => {
  if (SKIP_PATHS.has(req.path)) return next();

  const requestId = newRequestId();
  req.id = requestId;
  // Handed back so the browser can print it next to a failed request; that is
  // what makes a user-reported error findable in the server log.
  res.setHeader("X-Request-Id", requestId);

  runWithRequestId(requestId, () => {
    const startedAt = process.hrtime.bigint();

    // "finish" fires when the response has been handed to the socket, "close"
    // when the client hung up first — a constant occurrence on a media player,
    // and the case where a request would otherwise never be logged at all.
    let logged = false;
    const done = (outcome) => {
      if (logged) return;
      logged = true;
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const line =
        `${req.method} ${req.path}${summariseQuery(req.query)} ` +
        `${res.statusCode} ${ms.toFixed(1)}ms${outcome}`;
      logger[levelFor(res.statusCode)](line);
    };

    res.on("finish", () => done(""));
    res.on("close", () => done(" (client disconnected)"));

    next();
  });
};
