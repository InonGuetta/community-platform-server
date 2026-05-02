import { Server } from "socket.io";

export const initSockets = (httpServer) => {
  const io = new Server(httpServer, { cors: { origin: "*" } });

  io.on("connection", (socket) => {
    socket.on("join-room", ({ roomToken, userId, role }) => {
      socket.join(roomToken);
      socket.to(roomToken).emit("user-joined", { userId, role });
    });

    socket.on("leave-room", ({ roomToken, userId }) => {
      socket.leave(roomToken);
      socket.to(roomToken).emit("user-left", { userId });
    });

    socket.on("offer", (data) => socket.to(data.roomToken).emit("offer", data));
    socket.on("answer", (data) => socket.to(data.roomToken).emit("answer", data));
    socket.on("ice-candidate", (data) => socket.to(data.roomToken).emit("ice-candidate", data));

    socket.on("end-session", ({ roomToken }) => io.to(roomToken).emit("session-ended"));

    socket.on("disconnect", () => {
      socket.rooms.forEach((room) => {
        if (room !== socket.id) {
          socket.to(room).emit("user-left", { userId: socket.id });
        }
      });
    });
  });
};
