// @ts-check
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { getSessionByRoomToken, endSessionByRoomToken } from "../services/servicesSessions.js";
import { logger } from "../lib/logger.js";
import { env } from "../lib/env.js";
import { SOCKET_EVENTS, SOCKET_LIFECYCLE } from "./socketEvents.js";

// Pull the JWT out of the handshake's Cookie header (the same httpOnly `token`
// cookie the REST API uses). The client connects same-origin, so the browser
// sends it automatically — no token handling needed on the client side.
const tokenFromHandshake = (socket) => {
  const raw = socket.handshake.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "token") return decodeURIComponent(rest.join("="));
  }
  return null;
};

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
const traceIn = (socket, event) =>
  logger.debug(`[socket] ← ${event} (socket ${socket.id}, user ${socket.user?.id})`);

const traceOut = (target, event) => logger.debug(`[socket] → ${event} (to ${target})`);

// Registers a handler that is traced and cannot take the process down.
//
// The second part is the one that matters: socket.io does not catch what a
// handler throws, and an async handler that rejects becomes an
// unhandledRejection. The two DB-backed handlers below already guard themselves
// so they can answer the client properly; this is the backstop for the
// signalling handlers, which are synchronous today and would otherwise fail
// silently if that ever changed.
const onEvent = (socket, event, handler) => {
  socket.on(event, async (payload) => {
    traceIn(socket, event);
    try {
      await handler(payload);
    } catch (err) {
      logger.error(`[socket] ${event} handler threw: ${err.message}`);
    }
  });
};

// Returns the io instance so the caller can close it during shutdown —
// websockets are long-lived and would otherwise hold the process open.
export const initSockets = (httpServer) => {
  const io = new Server(httpServer, {
    cors: { origin: env.clientUrl, credentials: true },
  });

  // Reject unauthenticated sockets before any signaling can flow. The verified
  // identity — not client-supplied values — is what we relay to the room.
  io.use((socket, next) => {
    const token = tokenFromHandshake(socket);
    if (!token) {
      logger.debug("[socket] handshake rejected: no token cookie");
      return next(new Error("Unauthorized"));
    }
    try {
      const payload = jwt.verify(token, env.jwtSecret);
      socket.user = { id: payload.id, role: payload.role };
      next();
    } catch {
      logger.debug("[socket] handshake rejected: invalid token");
      next(new Error("Unauthorized"));
    }
  });

  io.on(SOCKET_LIFECYCLE.CONNECTION, (socket) => {
    logger.info(`[socket] connected ${socket.id} (user ${socket.user.id}, role ${socket.user.role})`);

    // Each connection is identified by socket.id — the stable key for every
    // peer in the mesh. Existing members are notified of a newcomer and are the
    // ones who initiate the offer toward it (socket.to() excludes the sender),
    // which keeps the handshake glare-free. The userId/role we broadcast come
    // from the verified token, not from the client payload.
    // A valid token alone used to be enough to join any string as a room, so a
    // client could sit in a room for a session that had ended or never existed.
    // The room token stays the capability — knowing it is what grants access —
    // but the session behind it now has to be real and still running.
    onEvent(socket, SOCKET_EVENTS.JOIN_ROOM, async ({ roomToken }) => {
      try {
        const session = await getSessionByRoomToken(roomToken);
        if (!session || !session.is_active) {
          logger.debug(`[socket] join refused for ${socket.id}: session missing or ended`);
          traceOut(socket.id, SOCKET_EVENTS.JOIN_ERROR);
          return socket.emit(SOCKET_EVENTS.JOIN_ERROR, { message: "Session not found or has ended" });
        }

        // max_participants has been stored since the first migration and never
        // enforced anywhere.
        const occupants = io.sockets.adapter.rooms.get(roomToken)?.size ?? 0;
        if (session.max_participants && occupants >= session.max_participants) {
          logger.debug(`[socket] join refused for ${socket.id}: room full (${occupants})`);
          traceOut(socket.id, SOCKET_EVENTS.JOIN_ERROR);
          return socket.emit(SOCKET_EVENTS.JOIN_ERROR, { message: "Session is full" });
        }

        socket.join(roomToken);
        logger.info(`[socket] ${socket.id} joined session ${session.id} (${occupants + 1} in room)`);
        traceOut(`room ${session.id}`, SOCKET_EVENTS.USER_JOINED);
        socket.to(roomToken).emit(SOCKET_EVENTS.USER_JOINED, {
          socketId: socket.id,
          userId: socket.user.id,
          role: socket.user.role,
        });
      } catch (err) {
        logger.error(`[socket] join-room failed: ${err.message}`);
        socket.emit(SOCKET_EVENTS.JOIN_ERROR, { message: "Could not join the session" });
      }
    });

    onEvent(socket, SOCKET_EVENTS.LEAVE_ROOM, ({ roomToken }) => {
      socket.leave(roomToken);
      traceOut("room", SOCKET_EVENTS.USER_LEFT);
      socket.to(roomToken).emit(SOCKET_EVENTS.USER_LEFT, { socketId: socket.id });
    });

    // Signaling is relayed to one specific peer (`to`) and stamped with the
    // sender's id (`from`) so the receiver knows which peer to answer.
    onEvent(socket, SOCKET_EVENTS.OFFER, ({ to, offer }) => {
      traceOut(to, SOCKET_EVENTS.OFFER);
      io.to(to).emit(SOCKET_EVENTS.OFFER, { from: socket.id, offer });
    });
    onEvent(socket, SOCKET_EVENTS.ANSWER, ({ to, answer }) => {
      traceOut(to, SOCKET_EVENTS.ANSWER);
      io.to(to).emit(SOCKET_EVENTS.ANSWER, { from: socket.id, answer });
    });
    onEvent(socket, SOCKET_EVENTS.ICE_CANDIDATE, ({ to, candidate }) => {
      traceOut(to, SOCKET_EVENTS.ICE_CANDIDATE);
      io.to(to).emit(SOCKET_EVENTS.ICE_CANDIDATE, { from: socket.id, candidate });
    });

    // Two bugs in one line before: any participant could end the session for
    // everyone, and ending it only broadcast — it never touched the database, so
    // is_active stayed TRUE and the session lingered in the active list forever.
    //
    // The UPDATE's WHERE clause is the authorization check (host only, matching
    // what DELETE /api/sessions/:id/end already enforced), so there is no gap
    // between deciding and acting. Only a row actually updated broadcasts.
    // The host id comes from the signed token and cannot be spoofed.
    onEvent(socket, SOCKET_EVENTS.END_SESSION, async ({ roomToken }) => {
      try {
        const ended = await endSessionByRoomToken(roomToken, socket.user.id);
        if (!ended) {
          logger.debug(`[socket] end-session refused for ${socket.id}: not the host`);
          return socket.emit(SOCKET_EVENTS.SESSION_ERROR, { message: "Only the host can end the session" });
        }
        logger.info(`[socket] session ended by user ${socket.user.id}`);
        traceOut("room", SOCKET_EVENTS.SESSION_ENDED);
        io.to(roomToken).emit(SOCKET_EVENTS.SESSION_ENDED);
      } catch (err) {
        logger.error(`[socket] end-session failed: ${err.message}`);
        socket.emit(SOCKET_EVENTS.SESSION_ERROR, { message: "Could not end the session" });
      }
    });

    // Use `disconnecting`, not `disconnect`: rooms are still populated here, so
    // we can tell the room which peer is leaving.
    socket.on(SOCKET_LIFECYCLE.DISCONNECTING, () => {
      socket.rooms.forEach((room) => {
        if (room !== socket.id) {
          traceOut("room", SOCKET_EVENTS.USER_LEFT);
          socket.to(room).emit(SOCKET_EVENTS.USER_LEFT, { socketId: socket.id });
        }
      });
    });

    socket.on(SOCKET_LIFECYCLE.DISCONNECT, (reason) =>
      logger.info(`[socket] disconnected ${socket.id} (${reason})`)
    );
  });

  return io;
};
