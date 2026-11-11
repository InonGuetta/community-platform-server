// @ts-check
// The host ending the session from the room. Registered per connection by
// initSockets; what follows the UPDATE is afterSessionEnded's (sessionEnd.js).
import { endSessionByRoomToken } from "../../services/servicesSessions.js";
import { logger } from "../../lib/logger.js";
import { SOCKET_EVENTS } from "../socketEvents.js";
import { onEvent } from "../socketShared.js";
import { afterSessionEnded } from "../sessionEnd.js";

export const registerSessionHandlers = (io, socket) => {
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
      await afterSessionEnded(ended, io);
    } catch (err) {
      logger.error(`[socket] end-session failed: ${err.message}`);
      socket.emit(SOCKET_EVENTS.SESSION_ERROR, { message: "Could not end the session" });
    }
  });
};
