import "dotenv/config";
import express from "express";
import { createServer } from "http";
import cors from "cors";
import helmet from "helmet";
import passport from "./config/passport.js";
import { pool } from "./db/pool.js";
import { initSockets } from "./sockets/socketManager.js";
import { errorHandler } from "./middleware/errorHandler.js";
import routersAuth from "./routes/routersAuth.js";
import routersUsers from "./routes/routersUsers.js";
import routersMedia from "./routes/routersMedia.js";
import routersSessions from "./routes/routersSessions.js";
import routersTranscripts from "./routes/routersTranscripts.js";
import routersBookmarks from "./routes/routersBookmarks.js";
import routersDonations from "./routes/routersDonations.js";
import routersAdmin from "./routes/routersAdmin.js";

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(passport.initialize());

app.use("/api/auth", routersAuth);
app.use("/api/users", routersUsers);
app.use("/api/media", routersMedia);
app.use("/api/sessions", routersSessions);
app.use("/api/transcripts", routersTranscripts);
app.use("/api/bookmarks", routersBookmarks);
app.use("/api/donations", routersDonations);
app.use("/api/admin", routersAdmin);

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use(errorHandler);

const httpServer = createServer(app);
initSockets(httpServer);

httpServer.listen(process.env.PORT || 3001, () =>
  console.log(`Server on port ${process.env.PORT || 3001}`)
);
