// @ts-check
// What every socket handler module uses: the tracing, the registration that
// cannot take the process down, and which session room a socket is in.
import { logger } from "../lib/logger.js";

// ── Instrumentation ─────────────────────────────────────────────────────────
//
// Socket traffic is the one part of this system with no HTTP request behind it,
// so none of it appears in the access log — which made a room that failed to
// connect almost impossible to diagnose from the outside.
//
// Payloads are never logged, only event names and peer ids. That is not only a
// privacy choice: an SDP offer is kilobytes of text and ICE candidates arrive in
// bursts of dozens per connection, so logging bodies would produce a log nobody
// can read. Everything here is `debug`, silent in production by default.
export const traceIn = (socket, event) =>
  logger.debug(`[socket] ← ${event} (socket ${socket.id}, user ${socket.user?.id})`);

export const traceOut = (target, event) => logger.debug(`[socket] → ${event} (to ${target})`);

// Registers a handler that is traced and cannot take the process down.
//
// The second part is the one that matters: socket.io does not catch what a
// handler throws, and an async handler that rejects becomes an
// unhandledRejection. The two DB-backed handlers below already guard themselves
// so they can answer the client properly; this is the backstop for the
// signalling handlers, which are synchronous today and would otherwise fail
// silently if that ever changed.
export const onEvent = (socket, event, handler) => {
  socket.on(event, async (payload) => {
    traceIn(socket, event);
    try {
      await handler(payload);
    } catch (err) {
      logger.error(`[socket] ${event} handler threw: ${err.message}`);
    }
  });
};

// ── Who a socket is allowed to talk to ──────────────────────────────────────
//
// Every socket sits in its own room named after its id; the session rooms are
// whatever is left once that one is removed.
export const sessionRoomsOf = (socket) => [...socket.rooms].filter((room) => room !== socket.id);
