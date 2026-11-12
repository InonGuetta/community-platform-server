// @ts-check
import express, { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { validateIntParam } from "../middleware/validateIntParam.js";
import * as controllersSessions from "../controllers/controllersSessions.js";

const router = Router();

router.use(verifyToken);

// Hosting a session was lecturer/admin-only in the UI but open to anyone on the
// API — the client merely hid the button.
const canHost = requireRole("lecturer", "admin");

router.post("/create", canHost, controllersSessions.createSession);
router.get("/active", controllersSessions.getActiveSessions);
// Before "/:id" — validateIntParam would otherwise reject the literal
// "upcoming" as a malformed id and this route would be unreachable.
router.get("/upcoming", controllersSessions.getUpcomingSessions);
router.get("/:id", validateIntParam("id"), controllersSessions.getSessionById);

// Entering a room. The only route that hands out a room token, and it does so
// only after the server has decided this caller may enter — see joinSession.
// Open to every signed-in user, which is the rule that was already in force when
// the token travelled on the public list; it is now enforced rather than implied.
router.get("/:id/calendar.ics", validateIntParam("id"), controllersSessions.getSessionCalendar);
router.post("/:id/join", validateIntParam("id"), controllersSessions.joinSession);

// Opening a scheduled session. Host-only in the WHERE clause; canHost is the
// visible first layer, as with ending one.
router.post("/:id/start", canHost, validateIntParam("id"), controllersSessions.startSession);
// Authorization for this one lived solely in the service layer — the
// "AND host_id=$2" in the UPDATE. That check is the real one and stays;
// requireRole is the cheap first layer that makes the rule visible here rather
// than only in a WHERE clause. Only lecturers and admins can create a session, so
// nobody else can be a host in the first place.
router.delete("/:id/end", canHost, validateIntParam("id"), controllersSessions.endSession);

// Recording (PRD REC-1). The host's browser starts a recording, sends it in
// numbered parts as it goes — a part sent again replaces itself, so a retry
// after a dropped connection is safe — and finishes it. Host-only in the
// service; canHost is the visible first layer. A part is raw bytes, read only
// on its own route and capped at the part size.
const rawPart = express.raw({ type: "application/octet-stream", limit: "8mb" });
router.post("/:id/recordings", canHost, validateIntParam("id"), controllersSessions.startRecording);
router.put(
  "/:id/recordings/:recordingId/parts/:part",
  // Not validateIntParam("part"): parts are numbered from 0, which it refuses.
  // The service checks the number.
  canHost, validateIntParam("id"), validateIntParam("recordingId"),
  rawPart, controllersSessions.uploadRecordingPart
);
router.post(
  "/:id/recordings/:recordingId/finish",
  canHost, validateIntParam("id"), validateIntParam("recordingId"),
  controllersSessions.finishRecording
);

// There was a POST /:id/recording here, and it was removed rather than left
// waiting for the feature it belonged to. Nothing ever called it: the column and
// this route were written for a recording feature the client never grew — there
// is no MediaRecorder anywhere in it — so for as long as it existed it was an
// endpoint with no caller and a real capability. Its key validation stopped a
// path traversal but not the simpler abuse: any host could point their session's
// recording_s3_key at any object already in the bucket.
//
// The live_sessions.recording_s3_key COLUMN is deliberately kept. It is a nullable
// column costing nothing, dropping it is a destructive migration bought for no
// gain, and it is exactly what a real recording feature would need on the day one
// is built. See ARCHITECTURE.md, "Open questions / known debt".

export default router;
