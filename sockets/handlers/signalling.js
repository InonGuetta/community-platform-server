// @ts-check
// The WebRTC signalling relayed between two peers in one room. Registered per
// connection by initSockets.
import { logger } from "../../lib/logger.js";
import { SOCKET_EVENTS } from "../socketEvents.js";
import { onEvent, traceOut, sessionRoomsOf } from "../socketShared.js";

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

export const registerSignallingHandlers = (io, socket) => {
  // Signaling is relayed to one specific peer (`to`) and stamped with the
  // sender's id (`from`) so the receiver knows which peer to answer. relaySignal
  // is what establishes that `to` is a peer the sender shares a room with.
  onEvent(socket, SOCKET_EVENTS.OFFER, ({ to, offer }) =>
    relaySignal(io, socket, SOCKET_EVENTS.OFFER, to, { offer }));
  onEvent(socket, SOCKET_EVENTS.ANSWER, ({ to, answer }) =>
    relaySignal(io, socket, SOCKET_EVENTS.ANSWER, to, { answer }));
  onEvent(socket, SOCKET_EVENTS.ICE_CANDIDATE, ({ to, candidate }) =>
    relaySignal(io, socket, SOCKET_EVENTS.ICE_CANDIDATE, to, { candidate }));
};
