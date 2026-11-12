// @ts-check
// Joining and leaving a session's room, and what a dropped socket leaves
// behind. Registered per connection by initSockets (socketManager.js).
import { getSessionByRoomToken } from "../../services/servicesSessions.js";
import { getActiveUserById } from "../../services/servicesAuth.js";
import { logger } from "../../lib/logger.js";
import { SOCKET_EVENTS, SOCKET_LIFECYCLE } from "../socketEvents.js";
import { onEvent, traceOut, sessionRoomsOf } from "../socketShared.js";
import { recordingRooms, recordingStatePayload, broadcastRecording, leaveRecording, seedAnswers } from "../recordingRooms.js";

// Whether admitting one more socket puts the room over its limit.
//
// Pulled out as its own function because the comparison is `>` and not `>=`, and
// that is only correct given WHERE it is called: the join now happens first, so
// `occupants` already counts the socket being admitted. Inlined, the next person
// to read it has every reason to "fix" it back to `>=` and quietly make every
// room one seat short.
export const exceedsCapacity = (occupants, maxParticipants) =>
  Boolean(maxParticipants) && occupants > maxParticipants;

export const registerRoomHandlers = (io, socket) => {
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
      // The handshake checked the account once; a socket can outlive that by
      // hours. Re-asked on every join (which is also every reconnect), so a
      // deactivated user's open connection cannot enter another room.
      const stillActive = await getActiveUserById(socket.user.id);
      if (!stillActive) {
        logger.debug(`[socket] join refused for ${socket.id}: account no longer active`);
        socket.emit(SOCKET_EVENTS.JOIN_ERROR, { message: "Unauthorized" });
        return socket.disconnect(true);
      }

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
      //
      // One room per socket. Chat sends to "the room this socket is in", and
      // with two of them it picked one arbitrarily. Joining a new room leaves
      // the previous one, announced the same way a disconnect is. Re-joining
      // the room it is already in (a duplicate emit) changes nothing.
      if (socket.rooms.has(roomToken)) {
        logger.debug(`[socket] ${socket.id} already in session ${session.id}`);
        return;
      }
      for (const previous of sessionRoomsOf(socket)) {
        leaveRecording(io, socket, previous);
        socket.leave(previous);
        socket.to(previous).emit(SOCKET_EVENTS.USER_LEFT, { socketId: socket.id });
      }
      socket.join(roomToken);
      const occupants = io.sockets.adapter.rooms.get(roomToken)?.size ?? 0;
      if (exceedsCapacity(occupants, session.max_participants)) {
        socket.leave(roomToken);
        logger.debug(`[socket] join refused for ${socket.id}: room full (${occupants - 1})`);
        traceOut(socket.id, SOCKET_EVENTS.JOIN_ERROR);
        return socket.emit(SOCKET_EVENTS.JOIN_ERROR, { message: "Session is full" });
      }

      logger.info(`[socket] ${socket.id} joined session ${session.id} (${occupants} in room)`);
      // Whether the room is being recorded, told to every newcomer — also
      // when it is not, which is how a host whose connection dropped learns
      // the room has forgotten its recording and announces it again.
      // Someone arriving mid-recording is asked like everyone else, and is
      // not recorded until they say yes — unless they already answered
      // before a dropped connection.
      const recording = recordingRooms.get(roomToken);
      if (recording) {
        await seedAnswers(io, roomToken, recording);
        broadcastRecording(io, roomToken);
      } else {
        traceOut(socket.id, SOCKET_EVENTS.RECORDING_STATE);
        socket.emit(SOCKET_EVENTS.RECORDING_STATE, recordingStatePayload(null));
      }
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
    leaveRecording(io, socket, roomToken);
    traceOut("room", SOCKET_EVENTS.USER_LEFT);
    socket.to(roomToken).emit(SOCKET_EVENTS.USER_LEFT, { socketId: socket.id });
  });
};

export const registerDisconnectHandlers = (io, socket) => {
  // Use `disconnecting`, not `disconnect`: rooms are still populated here, so
  // we can tell the room which peer is leaving.
  socket.on(SOCKET_LIFECYCLE.DISCONNECTING, () => {
    socket.rooms.forEach((room) => {
      if (room !== socket.id) {
        leaveRecording(io, socket, room);
        traceOut("room", SOCKET_EVENTS.USER_LEFT);
        socket.to(room).emit(SOCKET_EVENTS.USER_LEFT, { socketId: socket.id });
      }
    });
  });

  socket.on(SOCKET_LIFECYCLE.DISCONNECT, (reason) =>
    logger.info(`[socket] disconnected ${socket.id} (${reason})`)
  );
};
