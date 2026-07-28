import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { getSessionByRoomToken, endSessionByRoomToken } from "../services/servicesSessions.js";
import { logger } from "../lib/logger.js";

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

// Returns the io instance so the caller can close it during shutdown —
// websockets are long-lived and would otherwise hold the process open.
export const initSockets = (httpServer) => {
  const io = new Server(httpServer, {
    cors: { origin: process.env.CLIENT_URL || "http://localhost:5173", credentials: true },
  });

  // Reject unauthenticated sockets before any signaling can flow. The verified
  // identity — not client-supplied values — is what we relay to the room.
  io.use((socket, next) => {
    const token = tokenFromHandshake(socket);
    if (!token) return next(new Error("Unauthorized"));
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = { id: payload.id, role: payload.role };
      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    // Each connection is identified by socket.id — the stable key for every
    // peer in the mesh. Existing members are notified of a newcomer and are the
    // ones who initiate the offer toward it (socket.to() excludes the sender),
    // which keeps the handshake glare-free. The userId/role we broadcast come
    // from the verified token, not from the client payload.
    // A valid token alone used to be enough to join any string as a room, so a
    // client could sit in a room for a session that had ended or never existed.
    // The room token stays the capability — knowing it is what grants access —
    // but the session behind it now has to be real and still running.
    socket.on("join-room", async ({ roomToken }) => {
      try {
        const session = await getSessionByRoomToken(roomToken);
        if (!session || !session.is_active) {
          return socket.emit("join-error", { message: "Session not found or has ended" });
        }

        // max_participants has been stored since the first migration and never
        // enforced anywhere.
        const occupants = io.sockets.adapter.rooms.get(roomToken)?.size ?? 0;
        if (session.max_participants && occupants >= session.max_participants) {
          return socket.emit("join-error", { message: "Session is full" });
        }

        socket.join(roomToken);
        socket.to(roomToken).emit("user-joined", {
          socketId: socket.id,
          userId: socket.user.id,
          role: socket.user.role,
        });
      } catch (err) {
        logger.error(`[socket] join-room failed: ${err.message}`);
        socket.emit("join-error", { message: "Could not join the session" });
      }
    });

    socket.on("leave-room", ({ roomToken }) => {
      socket.leave(roomToken);
      socket.to(roomToken).emit("user-left", { socketId: socket.id });
    });

    // Signaling is relayed to one specific peer (`to`) and stamped with the
    // sender's id (`from`) so the receiver knows which peer to answer.
    socket.on("offer", ({ to, offer }) =>
      io.to(to).emit("offer", { from: socket.id, offer })
    );
    socket.on("answer", ({ to, answer }) =>
      io.to(to).emit("answer", { from: socket.id, answer })
    );
    socket.on("ice-candidate", ({ to, candidate }) =>
      io.to(to).emit("ice-candidate", { from: socket.id, candidate })
    );

    // Two bugs in one line before: any participant could end the session for
    // everyone, and ending it only broadcast — it never touched the database, so
    // is_active stayed TRUE and the session lingered in the active list forever.
    //
    // The UPDATE's WHERE clause is the authorization check (host only, matching
    // what DELETE /api/sessions/:id/end already enforced), so there is no gap
    // between deciding and acting. Only a row actually updated broadcasts.
    // The host id comes from the signed token and cannot be spoofed.
    socket.on("end-session", async ({ roomToken }) => {
      try {
        const ended = await endSessionByRoomToken(roomToken, socket.user.id);
        if (!ended) {
          return socket.emit("session-error", { message: "Only the host can end the session" });
        }
        io.to(roomToken).emit("session-ended");
      } catch (err) {
        logger.error(`[socket] end-session failed: ${err.message}`);
        socket.emit("session-error", { message: "Could not end the session" });
      }
    });

    // Use `disconnecting`, not `disconnect`: rooms are still populated here, so
    // we can tell the room which peer is leaving.
    socket.on("disconnecting", () => {
      socket.rooms.forEach((room) => {
        if (room !== socket.id) {
          socket.to(room).emit("user-left", { socketId: socket.id });
        }
      });
    });
  });

  return io;
};
