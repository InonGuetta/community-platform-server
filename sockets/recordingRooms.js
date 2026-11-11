// @ts-check
import { consentsFor } from "../services/servicesSessionRecordings.js";
import { SOCKET_EVENTS } from "./socketEvents.js";
import { traceOut } from "./socketShared.js";

// ── Recording consent (PRD REC-1) ───────────────────────────────────────────
//
// Which rooms are being recorded, and who in each has answered. In memory: it
// describes sockets, which exist only in this process, and a restart drops
// every socket with it. What must outlive the process — the recording and the
// answers — is in the database (migration 048).
//
//   roomToken → { recordingId, hostSocketId, answers: Map(socketId → { userId, consented }) }
//
// The host's own socket counts as consenting: the host started it.
export const recordingRooms = new Map();

/**
 * What every socket in the room is told: who is recorded, who declined.
 * Anyone in neither list has not answered yet — and is not recorded.
 * Exported for the tests.
 */
export const recordingStatePayload = (state) => {
  if (!state) return { active: false, recordingId: null, hostSocketId: null, consented: [], declined: [] };
  const consented = [state.hostSocketId];
  const declined = [];
  for (const [socketId, answer] of state.answers) {
    if (socketId === state.hostSocketId) continue;
    (answer.consented ? consented : declined).push(socketId);
  }
  return { active: true, recordingId: state.recordingId, hostSocketId: state.hostSocketId, consented, declined };
};

export const broadcastRecording = (io, room) => {
  traceOut("room", SOCKET_EVENTS.RECORDING_STATE);
  io.to(room).emit(SOCKET_EVENTS.RECORDING_STATE, recordingStatePayload(recordingRooms.get(room)));
};

// A socket leaving a room: its answer goes with it, and if it was the host's,
// the recording in that browser has stopped — the room is told so.
export const leaveRecording = (io, socket, room) => {
  const state = recordingRooms.get(room);
  if (!state) return;
  if (state.hostSocketId === socket.id) recordingRooms.delete(room);
  else if (!state.answers.delete(socket.id)) return;
  broadcastRecording(io, room);
};

// The answers on record for this recording, applied to the sockets now in the
// room — each socket by its user. A reconnect is a new socket id for the same
// person, and their answer stands.
export const seedAnswers = async (io, room, state) => {
  const known = await consentsFor(state.recordingId);
  for (const socketId of io.sockets.adapter.rooms.get(room) ?? []) {
    const user = io.sockets.sockets.get(socketId)?.user;
    if (socketId === state.hostSocketId || !user || !known.has(user.id)) continue;
    state.answers.set(socketId, { userId: user.id, consented: known.get(user.id) });
  }
};
