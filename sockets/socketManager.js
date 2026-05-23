import { Server } from "socket.io";

export const initSockets = (httpServer) => {
  const io = new Server(httpServer, { cors: { origin: "*" } });

  io.on("connection", (socket) => {
    // Each connection is identified by socket.id — the stable key for every
    // peer in the mesh. Existing members are notified of a newcomer and are the
    // ones who initiate the offer toward it (socket.to() excludes the sender),
    // which keeps the handshake glare-free.
    socket.on("join-room", ({ roomToken, userId, role }) => {
      socket.join(roomToken);
      socket.to(roomToken).emit("user-joined", { socketId: socket.id, userId, role });
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
};
