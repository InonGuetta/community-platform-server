// @ts-check
import * as servicesSessions from "../services/servicesSessions.js";
import { badRequest, notFound, ERROR_CODES } from "../lib/AppError.js";
import { notifySessionAudience, NOTIFICATION_TYPES } from "../services/servicesNotifications.js";
import { calendarForSession } from "../lib/ics.js";
import { optionalId, optionalTitle, sessionTypeFilter, optionalIntInRange, optionalSessionStart } from "../lib/validate.js";
import { assertCanManageCourse } from "../lib/permissions.js";
import * as servicesCourses from "../services/servicesCourses.js";
import { afterSessionEnded } from "../sockets/socketManager.js";
import * as servicesSessionRecordings from "../services/servicesSessionRecordings.js";

// The type, the scheduled time and their bounds are lib/validate.js's
// (SESSION_TYPES, optionalSessionStart); these two are this table's columns.
const TITLE_MAX = 255; // matches VARCHAR(255)
const MAX_PARTICIPANTS_CEILING = 100;

// room_token and recording_s3_key never leave the server.
//
// The same reasoning as publicMedia's s3_key, and the same mistake this file
// used to make in the other direction: both reads answered `SELECT s.*`, so the
// token ARCHITECTURE.md calls "the capability" travelled on every row of the
// public sessions list — for ended sessions too, alongside the storage key of
// any recording. A client that is never given the token cannot leak it, log it,
// or hold a stale one after being removed from a room.
const publicSession = ({ room_token, recording_s3_key, ...rest }) => rest;

export const createSession = async (req, res) => {
  const { title, sessionType, maxParticipants, scheduledAt, courseId } = req.body ?? {};

  // Title stays optional — the column is nullable and the sessions list already
  // renders "מפגש ללא כותרת" — so requiring it here would break a flow that
  // works today.
  const trimmedTitle = optionalTitle(title, TITLE_MAX);
  sessionTypeFilter(sessionType);
  const participants = optionalIntInRange(maxParticipants, "maxParticipants", 1, MAX_PARTICIPANTS_CEILING);
  // Absent means "start it now", which is what this endpoint has always done and
  // what every existing session is.
  const scheduled = optionalSessionStart(scheduledAt);

  // D8: the course a session is held for decides who is told about it. The
  // same rule as filing a lesson into a course: an admin any course, a lecturer
  // only one they teach — otherwise a lecturer could announce a session to
  // another lecturer's students. Absent or empty is a general session.
  const course = optionalId(courseId === "" ? undefined : courseId, "courseId");
  if (course !== undefined && course !== null) {
    assertCanManageCourse(req.user, await servicesCourses.getCourseById(course));
  }

  const session = await servicesSessions.createSession(req.user.id, {
    courseId: course ?? null,
    title: trimmedTitle || null,
    sessionType,
    maxParticipants: participants,
    scheduledAt: scheduled,
  });
  // NOTIF-2. Scheduled → "נקבע מפגש" with the calendar file attached; started
  // at once → "המפגש התחיל". Not awaited: the host is waiting for the room, and
  // a large audience's mail must not hold the response (the service never
  // throws). Who the audience is: notifySessionAudience.
  void notifySessionAudience(
    session.id,
    scheduled ? NOTIFICATION_TYPES.SESSION_SCHEDULED : NOTIFICATION_TYPES.SESSION_STARTING,
    scheduled ? { calendar: calendarForSession } : {}
  );
  res.status(201).json(publicSession(session));
};

export const getActiveSessions = async (req, res) => {
  const sessions = await servicesSessions.getActiveSessions();
  res.status(200).json(sessions.map(publicSession));
};

export const getUpcomingSessions = async (req, res) => {
  const sessions = await servicesSessions.getUpcomingSessions();
  res.status(200).json(sessions.map(publicSession));
};

export const getSessionById = async (req, res) => {
  const session = await servicesSessions.getSessionById(req.params.id);
  res.status(200).json(publicSession(session));
};

// The one place a room token reaches a client, and only after the server has
// decided this caller may enter this session. Everything else about a session
// travels through publicSession, which strips it.
//
// A POST rather than a GET: it is the act of entering a room, and a URL that
// hands out a live credential is one that ends up in a browser history, a proxy
// log and a shared link.
export const joinSession = async (req, res) => {
  const { roomToken, session } = await servicesSessions.getJoinableRoomToken(
    req.params.id,
    req.user.id
  );
  res.status(200).json({ roomToken, session: publicSession(session) });
};

export const startSession = async (req, res) => {
  // Read first, to know whether THIS call is the one that opens the room:
  // startSession answers the same for "started now" and "already live", and a
  // host pressing twice must not announce the session twice.
  const before = await servicesSessions.getSessionById(req.params.id);
  const session = await servicesSessions.startSession(req.params.id, req.user.id);
  if (!before.started_at && session.started_at) {
    void notifySessionAudience(session.id, NOTIFICATION_TYPES.SESSION_STARTING);
  }
  res.status(200).json(publicSession(session));
};

// NOTIF-3: the session as a calendar file, for the "הוספה ליומן" button. Any
// signed-in user, like the session itself. Only a session with a time — one
// started on the spot has nothing to put in a calendar.
export const getSessionCalendar = async (req, res) => {
  const session = await servicesSessions.getSessionSchedule(req.params.id);
  if (!session) throw notFound("Session not found", ERROR_CODES.SESSION_NOT_FOUND);
  if (!session.starts_at) throw badRequest("This session has no scheduled time");
  res
    .status(200)
    .type("text/calendar; charset=utf-8")
    .set("Content-Disposition", `attachment; filename="session-${session.id}.ics"`)
    .send(calendarForSession(session));
};

// Ending over REST closes the live room too. It used to update the row and tell
// nobody, so participants stayed connected, talking, in a session the list
// showed as ended — the socket END_SESSION path was the only one that told them.
// What follows the row is the same for both doors (afterSessionEnded): the
// room closed, then a recording still open joined.
export const endSession = async (req, res) => {
  const session = await servicesSessions.endSession(req.params.id, req.user.id);
  await afterSessionEnded(session);
  res.status(200).json(publicSession(session));
};

// ── Recording (PRD REC-1) ───────────────────────────────────────────────────
// The host's browser records and sends parts; see servicesSessionRecordings.js.
// The host-only rule is in the service (the session's host_id), behind canHost.

export const startRecording = async (req, res) => {
  const recording = await servicesSessionRecordings.startRecording(req.params.id, req.user.id, req.body?.mimeType);
  res.status(201).json(recording);
};

// The body is the part itself (application/octet-stream, express.raw).
export const uploadRecordingPart = async (req, res) => {
  await servicesSessionRecordings.savePart({
    sessionId: req.params.id,
    recordingId: req.params.recordingId,
    hostId: req.user.id,
    // Digits only — "1e3" or "0x10" is not a part number.
    partNumber: /^\d{1,5}$/.test(req.params.part) ? Number(req.params.part) : NaN,
    body: req.body,
  });
  res.status(204).end();
};

export const finishRecording = async (req, res) => {
  const recording = await servicesSessionRecordings.finishRecording(req.params.id, req.params.recordingId, req.user.id);
  res.status(200).json(recording);
};
