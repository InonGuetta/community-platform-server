// @ts-check
// The live sessions' socket server (PRD: live sessions). This file starts it
// and registers each concern's handlers on every connection; what each does
// is in its own module:
//
//   socketAuth.js         the handshake — who the socket is, from the cookie
//   socketShared.js       tracing, safe registration, the socket's room
//   recordingRooms.js     which rooms are being recorded, and who consented
//   sessionEnd.js         what follows a session's row being ended
//   handlers/room.js      joining, leaving, a dropped connection
//   handlers/recording.js the recording's start, stop and consent
//   handlers/chat.js      the room's chat
//   handlers/signalling.js the WebRTC offers, answers and candidates
//   handlers/session.js   the host ending the session
//
// What other modules and the tests import is re-exported here, so they keep
// importing from this one file.
import { Server } from "socket.io";
import { logger } from "../lib/logger.js";
import { env } from "../lib/env.js";
import { SOCKET_LIFECYCLE } from "./socketEvents.js";
import { authenticateSocket } from "./socketAuth.js";
import { setLiveIo } from "./sessionEnd.js";
import { registerRoomHandlers, registerDisconnectHandlers } from "./handlers/room.js";
import { registerRecordingHandlers } from "./handlers/recording.js";
import { registerChatHandlers } from "./handlers/chat.js";
import { registerSignallingHandlers } from "./handlers/signalling.js";
import { registerSessionHandlers } from "./handlers/session.js";

export { authenticateSocket } from "./socketAuth.js";
export { recordingStatePayload } from "./recordingRooms.js";
export { afterSessionEnded } from "./sessionEnd.js";
export { exceedsCapacity } from "./handlers/room.js";
export { createChatBucket } from "./handlers/chat.js";
export { sharesRoomWith } from "./handlers/signalling.js";

// Returns the io instance so the caller can close it during shutdown —
// websockets are long-lived and would otherwise hold the process open.
export const initSockets = (httpServer) => {
  const io = new Server(httpServer, {
    cors: { origin: env.clientUrl, credentials: true },
  });
  setLiveIo(io);

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

    // In the order they were always registered. Each registers its events on
    // this socket; the per-socket state they keep (the chat's flood bucket)
    // is created there, once per connection.
    registerRoomHandlers(io, socket);
    registerRecordingHandlers(io, socket);
    registerChatHandlers(io, socket);
    registerSignallingHandlers(io, socket);
    registerSessionHandlers(io, socket);
    registerDisconnectHandlers(io, socket);
  });

  return io;
};
