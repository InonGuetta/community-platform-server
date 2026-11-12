// @ts-check
// The recording's state in the room (PRD REC-1): the host's start and stop,
// and each participant's answer. Registered per connection by initSockets.
import { openRecordingInRoom, recordConsent } from "../../services/servicesSessionRecordings.js";
import { logger } from "../../lib/logger.js";
import { SOCKET_EVENTS } from "../socketEvents.js";
import { onEvent, sessionRoomsOf } from "../socketShared.js";
import { recordingRooms, broadcastRecording, seedAnswers } from "../recordingRooms.js";

export const registerRecordingHandlers = (io, socket) => {
  // ── Recording (PRD REC-1) ───────────────────────────────────────────────
  // The room always comes from the server's record of this socket's
  // membership, never from the payload — the rule chat and signalling follow.

  // The host has started a recording over REST and says so. Believed only
  // if that recording is the open one of THIS room's session and this user
  // hosts it.
  onEvent(socket, SOCKET_EVENTS.RECORDING_STARTED, async (/** @type {{ recordingId?: number }} */ { recordingId } = {}) => {
    const [room] = sessionRoomsOf(socket);
    if (!room) return;
    const recording = await openRecordingInRoom(Number(recordingId), room, socket.user.id);
    if (!recording) {
      logger.debug(`[socket] recording-started from ${socket.id} refused: not an open recording of its room`);
      return socket.emit(SOCKET_EVENTS.SESSION_ERROR, { message: "Only the host can record this session" });
    }
    const state = { recordingId: recording.id, hostSocketId: socket.id, answers: new Map() };
    await seedAnswers(io, room, state);
    recordingRooms.set(room, state);
    logger.info(`[socket] session ${recording.session_id} is being recorded (recording ${recording.id})`);
    broadcastRecording(io, room);
  });

  onEvent(socket, SOCKET_EVENTS.RECORDING_STOPPED, () => {
    const [room] = sessionRoomsOf(socket);
    const state = room && recordingRooms.get(room);
    if (!state || state.hostSocketId !== socket.id) return;
    recordingRooms.delete(room);
    broadcastRecording(io, room);
  });

  // A participant's answer. Only `true` is consent — anything else, absent
  // or malformed included, is a no. Stored before the room is told, so the
  // host never mixes in someone whose consent is not on record.
  onEvent(socket, SOCKET_EVENTS.RECORDING_CONSENT, async (/** @type {{ consent?: boolean }} */ { consent } = {}) => {
    const [room] = sessionRoomsOf(socket);
    const state = room && recordingRooms.get(room);
    if (!state || state.hostSocketId === socket.id) return;
    const consented = consent === true;
    await recordConsent(state.recordingId, socket.user.id, consented);
    // The recording may have stopped while that was being written.
    if (recordingRooms.get(room) !== state) return;
    state.answers.set(socket.id, { userId: socket.user.id, consented });
    broadcastRecording(io, room);
  });
};
