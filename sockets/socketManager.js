import { Server } from "socket.io";
import jwt from "jsonwebtoken";

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
    socket.on("join-room", ({ roomToken }) => {
      socket.join(roomToken);
      socket.to(roomToken).emit("user-joined", {
        socketId: socket.id,
        userId: socket.user.id,
        role: socket.user.role,
      });
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

    socket.on("end-session", ({ roomToken }) => io.to(roomToken).emit("session-ended"));

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
