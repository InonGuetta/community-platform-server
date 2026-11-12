// @ts-check
// The room's chat. Registered per connection by initSockets.
import { saveChatMessage } from "../../services/servicesSessionRecordings.js";
import { logger } from "../../lib/logger.js";
import { SOCKET_EVENTS } from "../socketEvents.js";
import { onEvent, traceOut, sessionRoomsOf } from "../socketShared.js";
import { recordingRooms } from "../recordingRooms.js";

// Long enough for a source reference or a question, short enough that one
// participant cannot fill everybody's panel with a single paste.
const CHAT_MAX_CHARS = 2000;

// ── Chat flood control ──────────────────────────────────────────────────────
//
// A token bucket per socket: a burst of CHAT_BURST messages, then one every
// CHAT_REFILL_MS. Nothing limited this before, so one client in a loop could
// broadcast 2000-character messages to every participant as fast as the socket
// allowed. Generous for a person typing; useless for a script.
//
// Exported, with the clock injectable, so the rule can be tested without timers.
const CHAT_BURST = 5;
const CHAT_REFILL_MS = 1000;

export const createChatBucket = ({ burst = CHAT_BURST, refillMs = CHAT_REFILL_MS, now = Date.now } = {}) => {
  let tokens = burst;
  let last = now();
  return () => {
    const current = now();
    tokens = Math.min(burst, tokens + (current - last) / refillMs);
    last = current;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
};

export const registerChatHandlers = (io, socket) => {
  // Chat, broadcast to the room the sender is actually in.
  //
  // The room comes from the server's own record of this socket's membership,
  // never from the payload — the same rule the signalling relay follows, and
  // for the same reason: a roomToken in a message body is a claim, and a
  // client that could name any room could speak into any room.
  //
  // Relayed, not kept — with one exception, at the end of this handler. A
  // session is a conversation, not a record: keeping it would mean a retention
  // decision, a deletion path and a place for it to be read back. The exception
  // is a room being recorded (PRD REC-3), where the lines of the people whose
  // voices are in the recording become the lesson's appendix.
  //
  // CHAT_HISTORY is in the event list and the client listens for it, but the
  // server sends none: a live room holds nothing to replay.
  const allowChat = createChatBucket();
  onEvent(socket, SOCKET_EVENTS.CHAT_MESSAGE, async ({ text }) => {
    const [room] = sessionRoomsOf(socket);
    if (!room) {
      logger.debug(`[socket] chat from ${socket.id} ignored: not in a room`);
      return;
    }
    if (!allowChat()) {
      logger.debug(`[socket] chat from ${socket.id} dropped: rate limited`);
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
      // From the verified row, like userId — so a participant can see who
      // wrote a message, and nobody can claim to be someone else.
      displayName: socket.user.displayName,
      text: body,
      at: Date.now(),
    };
    traceOut("room", SOCKET_EVENTS.CHAT_MESSAGE);
    // io.to, not socket.to: the sender gets their own message back, so every
    // participant renders the same list in the same order — the server's — and
    // nobody has to reconcile an optimistic local copy against it.
    io.to(room).emit(SOCKET_EVENTS.CHAT_MESSAGE, message);

    // The one case a chat line is kept (PRD REC-3, migration 049): the room
    // is being recorded and the writer's voice is in the recording — the
    // host, or someone who said yes. It becomes the lesson's appendix.
    const recording = recordingRooms.get(room);
    if (recording && (socket.id === recording.hostSocketId || recording.answers.get(socket.id)?.consented)) {
      await saveChatMessage(recording.recordingId, socket.user, body);
    }
  });
};
