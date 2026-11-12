// @ts-check
import { finishOpenRecordings } from "../services/servicesSessionRecordings.js";
import { SOCKET_EVENTS } from "./socketEvents.js";
import { traceOut } from "./socketShared.js";
import { recordingRooms } from "./recordingRooms.js";

// Ending a room: tell everyone in it, then take every socket OUT of it. The
// broadcast alone left the sockets in the room, so a client that ignored
// SESSION_ENDED could keep chatting and relaying signalling in a session the
// database says is over.
const closeRoom = (io, roomToken) => {
  recordingRooms.delete(roomToken);
  traceOut("room", SOCKET_EVENTS.SESSION_ENDED);
  io.to(roomToken).emit(SOCKET_EVENTS.SESSION_ENDED);
  io.in(roomToken).socketsLeave(roomToken);
};

// The live server, for the one caller outside this file that needs it: the
// REST "end session" route, which used to update the row and tell nobody in the
// room. Set by initSockets; null in the worker processes, where there are no
// sockets to close.
let liveIo = null;

/** @param {import("socket.io").Server} io  set by initSockets */
export const setLiveIo = (io) => { liveIo = io; };

// ── Ending a session: what follows the row, whichever door ended it ─────────
//
// Two doors end a session: DELETE /api/sessions/:id/end (controllersSessions)
// and the host's END_SESSION below. Each ends the row its own way — by id, and
// idempotently, over REST; by room token over the socket — because in both the
// UPDATE's WHERE clause is the host check. What follows is the same, and is
// here, in this order:
//
//   1. the room is told SESSION_ENDED and emptied (closeRoom);
//   2. a recording still open is joined from what reached the server (PRD
//      REC-1). finishOpenRecordings never throws, so the session is ended
//      whatever happens to the recording.
//
// `io` is the socket handler's own server; the REST route leaves it to the one
// initSockets stored — null where there is no room to close.
/**
 * @param {{ id: number, room_token: string }} session  the ended row
 * @param {import("socket.io").Server | null} [io]
 */
export const afterSessionEnded = async (session, io = liveIo) => {
  if (io && session.room_token) closeRoom(io, session.room_token);
  await finishOpenRecordings(session.id);
};
