// @ts-check
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { getSessionByRoomToken, endSessionByRoomToken } from "../services/servicesSessions.js";
import { getActiveUserById } from "../services/servicesAuth.js";
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

// Reject unauthenticated sockets before any signalling can flow. The verified
// identity — not client-supplied values — is what gets relayed to the room.
//
// A valid signature is NOT sufficient, and the second step is why. The token
// lasts seven days and carries a snapshot of the role it was minted with, so on
// signature alone a user who was deactivated or demoted keeps whatever they had
// until it expires. verifyToken has re-read the row on every REST request from
// the beginning for exactly this reason; this side was trusting the claims, so
// closing an account shut the API to them while leaving their live signalling
// connection — and their ability to end a session they host — untouched.
//
// Same lookup as the REST path, from the same function, so the two cannot answer
// differently. Exported so the rule can be tested without standing up a server.
export const authenticateSocket = async (socket, next) => {
  const token = tokenFromHandshake(socket);
  if (!token) {
    logger.debug("[socket] handshake rejected: no token cookie");
    return next(new Error("Unauthorized"));
  }

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    logger.debug("[socket] handshake rejected: invalid token");
    return next(new Error("Unauthorized"));
  }

  try {
    const user = await getActiveUserById(payload.id);
    if (!user) {
      logger.debug("[socket] handshake rejected: no active user behind the token");
      return next(new Error("Unauthorized"));
    }
    // The row, not the token's claims — a role changed since the token was signed
    // takes effect on the next connection rather than on expiry.
    socket.user = { id: user.id, role: user.role };
    next();
  } catch (err) {
    // The database being unreachable is not the caller's fault, but a handshake
    // has no way to say "try again later". Logged at error so a burst of refusals
    // during an outage is distinguishable from genuine rejections, which are debug.
    logger.error(`[socket] handshake failed to verify user: ${err.message}`);
    next(new Error("Unauthorized"));
  }
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

// ── Who a socket is allowed to talk to ──────────────────────────────────────
//
// Every socket sits in its own room named after its id; the session rooms are
// whatever is left once that one is removed.
const sessionRoomsOf = (socket) => [...socket.rooms].filter((room) => room !== socket.id);

// Signalling is addressed by socket id, and the id used to be taken at face
// value: `io.to(to).emit(...)` will deliver to ANY connected socket, so any
// authenticated user could push an offer, an answer or a stream of ICE candidates
// at a peer in a room they had never joined. The join path had grown a careful
// check — the session must exist and still be running — while the three handlers
// that actually move data had none.
//
// A peer is addressable only from inside a room both sockets are in. The sender's
// membership comes from the server's own adapter, never from the payload.
// Exported for the tests. The io/socket shapes it touches are small — an adapter
// with a room map, and a socket with an id and a room set — so the rule can be
// driven over plain objects instead of a live server, the same trade the client's
// peerMesh.js makes with RTCPeerConnection.
export const sharesRoomWith = (io, socket, targetId) =>
  typeof targetId === "string" &&
  targetId !== socket.id &&
  sessionRoomsOf(socket).some((room) => io.sockets.adapter.rooms.get(room)?.has(targetId));

// Whether admitting one more socket puts the room over its limit.
//
// Pulled out as its own function because the comparison is `>` and not `>=`, and
// that is only correct given WHERE it is called: the join now happens first, so
// `occupants` already counts the socket being admitted. Inlined, the next person
// to read it has every reason to "fix" it back to `>=` and quietly make every
// room one seat short.
export const exceedsCapacity = (occupants, maxParticipants) =>
  Boolean(maxParticipants) && occupants > maxParticipants;

// Long enough for a source reference or a question, short enough that one
// participant cannot fill everybody's panel with a single paste.
const CHAT_MAX_CHARS = 2000;

// One relay for the three signalling events, so the check cannot be present on
// two of them and forgotten on the third.
const relaySignal = (io, socket, event, to, body) => {
  if (!sharesRoomWith(io, socket, to)) {
    logger.debug(`[socket] ${event} from ${socket.id} refused: ${to} is not a peer in its room`);
    return;
  }
  traceOut(to, event);
  io.to(to).emit(event, { from: socket.id, ...body });
};

// Returns the io instance so the caller can close it during shutdown —
// websockets are long-lived and would otherwise hold the process open.
export const initSockets = (httpServer) => {
  const io = new Server(httpServer, {
    cors: { origin: env.clientUrl, credentials: true },
  });

  // Reject unauthenticated sockets before any signaling can flow. The verified
  // identity — not client-supplied values — is what we relay to the room.
  //
  // A valid signature is NOT sufficient, and the second step is why. The token
  // lasts seven days and carries a snapshot of the role it was minted with, so on
  // signature alone a user who was deactivated or demoted keeps whatever they had
  // until it expires. verifyToken has re-read the row on every REST request from
  // the beginning for exactly this reason; this side was trusting the claims, so
  // closing an account shut the API to them while leaving their live signalling
  // connection — and their ability to end a session they host — untouched.
  //
  // Same lookup as the REST path, from the same function, so the two cannot
  // answer differently.
  io.use(authenticateSocket);

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

        // A scheduled session exists before it begins, and its room must not.
        // Otherwise the first person to try the link ten minutes early sits alone
        // in a room the host has not opened, and the host arrives to find people
        // already "in" a session that never started.
        if (!session.started_at) {
          logger.debug(`[socket] join refused for ${socket.id}: session ${session.id} has not started`);
          traceOut(socket.id, SOCKET_EVENTS.JOIN_ERROR);
          return socket.emit(SOCKET_EVENTS.JOIN_ERROR, { message: "This session has not started yet" });
        }

        // max_participants has been stored since the first migration and never
        // enforced anywhere.
        //
        // Join FIRST, then count, then step back out if that put the room over.
        // Counting before joining reads a number that the await above has already
        // made stale: two clients arriving together both see the room one short of
        // full and both proceed. Joining and counting sit next to each other with
        // no await between them, so on a single event loop no other join can
        // interleave — the count each one reads already includes itself and every
        // socket that got in first.
        socket.join(roomToken);
        const occupants = io.sockets.adapter.rooms.get(roomToken)?.size ?? 0;
        if (exceedsCapacity(occupants, session.max_participants)) {
          socket.leave(roomToken);
          logger.debug(`[socket] join refused for ${socket.id}: room full (${occupants - 1})`);
          traceOut(socket.id, SOCKET_EVENTS.JOIN_ERROR);
          return socket.emit(SOCKET_EVENTS.JOIN_ERROR, { message: "Session is full" });
        }

        logger.info(`[socket] ${socket.id} joined session ${session.id} (${occupants} in room)`);
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

    // Leaving is only meaningful for a room this socket is actually in. Without
    // the guard the token alone was enough to announce somebody else's departure
    // into any room whose token was known — and the tokens are not secret from a
    // signed-in user, since the sessions list hands them out.
    onEvent(socket, SOCKET_EVENTS.LEAVE_ROOM, ({ roomToken }) => {
      if (!socket.rooms.has(roomToken)) {
        logger.debug(`[socket] leave-room from ${socket.id} ignored: not in ${roomToken}`);
        return;
      }
      socket.leave(roomToken);
      traceOut("room", SOCKET_EVENTS.USER_LEFT);
      socket.to(roomToken).emit(SOCKET_EVENTS.USER_LEFT, { socketId: socket.id });
    });

    // Chat, broadcast to the room the sender is actually in.
    //
    // The room comes from the server's own record of this socket's membership,
    // never from the payload — the same rule the signalling relay follows, and
    // for the same reason: a roomToken in a message body is a claim, and a
    // client that could name any room could speak into any room.
    //
    // Nothing is stored. A session is a conversation, not a record: persisting
    // it would mean a retention decision, a deletion path and a place for it to
    // be read back, none of which anyone has asked for. CHAT_HISTORY exists so a
    // reconnect is not silent about that — it replays what the server holds,
    // which for now is nothing.
    onEvent(socket, SOCKET_EVENTS.CHAT_MESSAGE, ({ text }) => {
      const [room] = sessionRoomsOf(socket);
      if (!room) {
        logger.debug(`[socket] chat from ${socket.id} ignored: not in a room`);
        return;
      }
      // Trimmed and capped here rather than trusted: it is broadcast verbatim to
      // everyone in the room, and length is the only thing a relay can sensibly
      // police. The client renders it as text, never as markup.
      const body = String(text ?? "").trim().slice(0, CHAT_MAX_CHARS);
      if (!body) return;

      const message = {
        from: socket.id,
        userId: socket.user.id,
        text: body,
        at: Date.now(),
      };
      traceOut("room", SOCKET_EVENTS.CHAT_MESSAGE);
      // io.to, not socket.to: the sender gets their own message back, so every
      // participant renders the same list in the same order — the server's — and
      // nobody has to reconcile an optimistic local copy against it.
      io.to(room).emit(SOCKET_EVENTS.CHAT_MESSAGE, message);
    });

    // Signaling is relayed to one specific peer (`to`) and stamped with the
    // sender's id (`from`) so the receiver knows which peer to answer. relaySignal
    // is what establishes that `to` is a peer the sender shares a room with.
    onEvent(socket, SOCKET_EVENTS.OFFER, ({ to, offer }) =>
      relaySignal(io, socket, SOCKET_EVENTS.OFFER, to, { offer }));
    onEvent(socket, SOCKET_EVENTS.ANSWER, ({ to, answer }) =>
      relaySignal(io, socket, SOCKET_EVENTS.ANSWER, to, { answer }));
    onEvent(socket, SOCKET_EVENTS.ICE_CANDIDATE, ({ to, candidate }) =>
      relaySignal(io, socket, SOCKET_EVENTS.ICE_CANDIDATE, to, { candidate }));

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
