// @ts-check
// ── Recording a live session (PRD REC-1, migration 048) ──────────────────────
//
// The server never sees a session's media — the mesh is peer to peer — so the
// recording is made in the HOST's browser: it mixes the audio of everyone who
// agreed to be recorded (the consent travels over the socket, see
// sockets/handlers/recording.js) and sends it here in numbered parts while the
// session runs. This module is the server's half:
//
//   startRecording   a row for a new recording; closes a previous open one
//   savePart         one numbered part, written to disk; the same number sent
//                    again replaces it, so a retry after a dropped connection
//                    is always safe
//   finishRecording  joins the parts 0..n-1 that arrived, in order, into one
//                    file — on S3 when it is configured, on local disk when not
//   finishOpenRecordings
//                    the same, for whatever is still open when the session
//                    ends: a host whose tab closed mid-session still leaves a
//                    recording of everything that reached the server
//   recordConsent    who agreed, kept with the recording (the evidence)
//   saveChatMessage  a chat line written while recording, by someone whose
//                    voice is in it (migration 049)
//   lessonFromRecording
//                    the finished recording as a DRAFT lesson in the session's
//                    course, the host as its lecturer, the chat copied on as
//                    an appendix, and the pipeline started (PRD REC-2, REC-3)
//
// Parts of a MediaRecorder recording are pieces of ONE stream: only the first
// carries the container's header, and the parts joined in order are a valid
// file. That is why a part is identified by its number and why only a gapless
// run from part 0 is kept — a hole in the middle would make the rest unplayable.
import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { AppError, notFound, forbidden, conflict, ERROR_CODES } from "../lib/AppError.js";
import { createPartsDir, writePart, removeParts, assembleRecording } from "../lib/recordingFiles.js";
import { createMedia } from "./servicesMedia.js";

// The parts directory and the run of parts on disk are lib/recordingFiles.js's;
// re-exported, because the tests, smoke and backup:status ask this module.
export { PARTS_DIR, contiguousParts } from "../lib/recordingFiles.js";

// A part is ten seconds of Opus audio in practice (~20–40 KB); the ceiling is
// for a browser that chooses a far higher bitrate, not a target.
export const MAX_PART_BYTES = 8 * 1024 * 1024;
// Ten-second parts for twelve hours. A number past it is not a recording.
export const MAX_PART_NUMBER = 5000;

// What a browser may say it is recording. Audio only, by design: the pipeline
// transcribes audio, and the mixed audio is what every participant agreed to.
const ALLOWED_MIME = /^audio\/(webm|ogg|mp4)(;\s*codecs=[\w.,"' -]+)?$/i;

const RECORDING_COLS = "id, session_id, host_id, status, mime_type, parts, bytes, s3_key, started_at, finished_at, media_id";

/**
 * The session, only if the caller hosts it and it is running now. 404 for a
 * session that does not exist, 403 for someone else's, 409 for one not live.
 * @param {number|string} sessionId
 * @param {number} hostId
 */
const liveSessionOfHost = async (sessionId, hostId) => {
  const { rows } = await pool.query(
    "SELECT id, host_id, is_active, started_at FROM live_sessions WHERE id=$1",
    [sessionId]
  );
  const session = rows[0];
  if (!session) throw notFound("Session not found", ERROR_CODES.SESSION_NOT_FOUND);
  if (Number(session.host_id) !== Number(hostId)) {
    throw forbidden("Only the host can record this session", ERROR_CODES.SESSION_FORBIDDEN);
  }
  if (!session.is_active || !session.started_at) {
    throw conflict("The session is not running", ERROR_CODES.SESSION_NOT_STARTED);
  }
  return session;
};

/**
 * The recording, only if it belongs to this session and this host — another
 * host's recording id is a 404, like one that does not exist.
 */
const recordingOfHost = async (recordingId, sessionId, hostId) => {
  const { rows } = await pool.query(
    `SELECT ${RECORDING_COLS} FROM session_recordings
     WHERE id=$1 AND session_id=$2 AND host_id=$3`,
    [recordingId, sessionId, hostId]
  );
  if (rows.length === 0) throw notFound("Recording not found", ERROR_CODES.RECORDING_NOT_FOUND);
  return rows[0];
};

/**
 * Start recording a running session the caller hosts.
 * @param {number|string} sessionId
 * @param {number} hostId
 * @param {string} mimeType  what the browser's MediaRecorder will produce
 */
export const startRecording = async (sessionId, hostId, mimeType) => {
  const mime = String(mimeType ?? "").trim();
  if (!ALLOWED_MIME.test(mime)) {
    throw new AppError("Unsupported recording format", 400, ERROR_CODES.BAD_REQUEST);
  }
  await liveSessionOfHost(sessionId, hostId);

  // A host who reloaded the page starts a new MediaRecorder, whose parts are a
  // new stream and cannot continue the old file. The old recording is closed
  // with what it has, so nothing that reached the server is lost.
  await finishOpenRecordings(sessionId);

  const { rows } = await pool.query(
    `INSERT INTO session_recordings (session_id, host_id, mime_type)
     VALUES ($1, $2, $3)
     RETURNING ${RECORDING_COLS}`,
    [sessionId, hostId, mime]
  );
  await createPartsDir(rows[0].id);
  logger.info(`[BE:svc] startRecording session=${sessionId} ✓ recording=${rows[0].id}`);
  return rows[0];
};

/**
 * Store one numbered part. Writing the same number again replaces it — the
 * client resends a part whose answer it never saw.
 * @param {object} args
 * @param {number|string} args.sessionId
 * @param {number|string} args.recordingId
 * @param {number} args.hostId
 * @param {number} args.partNumber
 * @param {Buffer} args.body
 */
export const savePart = async ({ sessionId, recordingId, hostId, partNumber, body }) => {
  if (!Number.isInteger(partNumber) || partNumber < 0 || partNumber > MAX_PART_NUMBER) {
    throw new AppError("Invalid part number", 400, ERROR_CODES.BAD_REQUEST);
  }
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new AppError("A part must not be empty", 400, ERROR_CODES.BAD_REQUEST);
  }
  if (body.length > MAX_PART_BYTES) {
    throw new AppError("Part too large", 413, ERROR_CODES.BAD_REQUEST);
  }
  const recording = await recordingOfHost(recordingId, sessionId, hostId);
  if (recording.status !== "recording") {
    throw conflict("This recording is already finished", ERROR_CODES.RECORDING_CLOSED);
  }

  // Atomically, by rename — see writePart (lib/recordingFiles.js).
  await writePart(recording.id, partNumber, body);
};

/**
 * Close one recording: join what arrived, store it, mark it. Claimed in its
 * UPDATE first, so two callers (the host's "stop" and the end of the session
 * arriving together) cannot both join and store it.
 */
const closeRecording = async (recording, lessonDeps = undefined) => {
  const claim = await pool.query(
    `UPDATE session_recordings SET status='failed', finished_at=NOW()
     WHERE id=$1 AND status='recording'
     RETURNING ${RECORDING_COLS}`,
    [recording.id]
  );
  // Someone else closed it; theirs is the answer.
  if (claim.rows.length === 0) {
    const { rows } = await pool.query(`SELECT ${RECORDING_COLS} FROM session_recordings WHERE id=$1`, [recording.id]);
    return rows[0];
  }

  let stored;
  try {
    stored = await assembleRecording(recording);
  } catch (err) {
    // Left 'failed' with its parts still on disk — nothing deleted, so it can
    // be joined by hand. Logged without any content, only the ids.
    logger.error(`[BE:svc] recording=${recording.id} could not be joined — ${err.message}`);
    return claim.rows[0];
  }
  if (!stored.s3Key) {
    logger.warn(`[BE:svc] recording=${recording.id} finished with no parts`);
    await removeParts(recording.id);
    return claim.rows[0];
  }

  const { rows } = await pool.query(
    `WITH done AS (
       UPDATE session_recordings
       SET status='finished', s3_key=$2, parts=$3, bytes=$4
       WHERE id=$1
       RETURNING ${RECORDING_COLS}
     ), session AS (
       UPDATE live_sessions SET recording_s3_key=$2 WHERE id=(SELECT session_id FROM done)
     )
     SELECT * FROM done`,
    [recording.id, stored.s3Key, stored.parts, stored.bytes]
  );
  await removeParts(recording.id);
  logger.info(`[BE:svc] recording=${recording.id} ✓ finished, ${stored.parts} part(s), ${stored.bytes} bytes`);
  const mediaId = await lessonFromRecording(rows[0], stored.durationSeconds, lessonDeps);
  return { ...rows[0], media_id: mediaId ?? rows[0].media_id };
};

// ── The recording as a lesson (PRD REC-2, REC-3) ───────────────────────────

// "dd.mm.yyyy", in Israel — the date people will remember the session by.
const dateInIsrael = (when) =>
  new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" })
    .format(new Date(when ?? Date.now()));

const TITLE_MAX = 255;

/**
 * The lesson's title: the session's, marked as a recording, and numbered when
 * the session was recorded in more than one part.
 * Exported for the tests.
 * @param {string} sessionTitle
 * @param {number} part  1-based
 * @param {number} parts
 */
export const lessonTitle = (sessionTitle, part, parts) => {
  const base = `${String(sessionTitle ?? "").trim() || "מפגש"} — הקלטת מפגש`;
  const suffix = parts > 1 ? ` (חלק ${part})` : "";
  return `${base.slice(0, TITLE_MAX - suffix.length)}${suffix}`;
};

// Loaded when used, not at import: the pipeline opens the Bull queues (Redis
// connections) the moment it is imported, and this module is imported by the
// socket manager and the media controller — every process and test that loads
// them would otherwise hold Redis connections open for nothing.
const triggerPipelineLazily = async (mediaId) =>
  (await import("./transcripts/pipeline.js")).triggerPipeline(mediaId);

/**
 * Make the finished recording a lesson. Never throws — the recording is
 * already saved, and a failure here leaves it saved (and logged) rather than
 * reporting the whole stop as failed. Returns the lesson's id, or null.
 *
 * A DRAFT: participants agreed to be recorded, and the host decides whether
 * the result is shown — publishing it (the lesson's edit dialog) is what tells
 * the course's students, through the existing new-lesson notice. The pipeline
 * starts at once, so the lesson is transcribed and summarised by the time the
 * host looks at it.
 * @param {any} recording  a finished row
 * @param {number|null} durationSeconds
 * @param {{ trigger: (mediaId: number) => Promise<any> }} [deps]  the tests' stand-in for the queue
 */
export const lessonFromRecording = async (recording, durationSeconds, deps = { trigger: triggerPipelineLazily }) => {
  try {
    const { rows: [session] } = await pool.query(
      `SELECT s.id, s.title, s.course_id, s.started_at, u.display_name AS host_name,
              (SELECT COUNT(*)::int FROM session_recordings r
                WHERE r.session_id = s.id AND r.status = 'finished') AS finished,
              (SELECT COUNT(*)::int FROM session_recordings r
                WHERE r.session_id = s.id AND r.status = 'finished' AND r.id <= $2) AS part
         FROM live_sessions s JOIN users u ON u.id = s.host_id
        WHERE s.id = $1`,
      [recording.session_id, recording.id]
    );
    if (!session) return null;

    const media = await createMedia({
      uploaderId: recording.host_id,
      title: lessonTitle(session.title, session.part, Math.max(session.finished, session.part)),
      description: `הקלטה של המפגש "${String(session.title ?? "").trim()}" מתאריך ${dateInIsrael(session.started_at ?? recording.started_at)}.`,
      mediaType: "audio",
      s3Key: recording.s3_key,
      durationSeconds: durationSeconds ?? null,
      courseId: session.course_id ?? null,
      lecturerId: recording.host_id,
      creatorName: session.host_name,
    });

    // The session, the link back from the recording, and the chat copied on —
    // the chat as it stands now, never a reference to rows that may go.
    await pool.query(
      `WITH linked AS (
         UPDATE media_items SET session_id = $2 WHERE id = $1
       ), rec AS (
         UPDATE session_recordings SET media_id = $1 WHERE id = $3
       )
       INSERT INTO media_session_chat (media_id, messages)
       SELECT $1, COALESCE(jsonb_agg(jsonb_build_object(
                'name', c.display_name, 'text', c.body, 'at', c.sent_at,
                -- Where in the recording it was written, so the lesson page
                -- can play the moment a message was about.
                'offset', GREATEST(0, FLOOR(EXTRACT(EPOCH FROM c.sent_at - r.started_at)))::int
              ) ORDER BY c.id), '[]'::jsonb)
         FROM session_recording_chat c
         JOIN session_recordings r ON r.id = c.recording_id
        WHERE c.recording_id = $3
       ON CONFLICT (media_id) DO NOTHING`,
      [media.id, session.id, recording.id]
    );
    logger.info(`[BE:svc] recording=${recording.id} ✓ lesson media=${media.id} (draft)`);

    // Transcription and summary. Its own failure (Redis down, the monthly AI
    // cap reached) leaves the lesson without a transcript and the host can
    // press "תמלל" on it later — the lesson itself stands.
    try {
      await deps.trigger(media.id);
    } catch (err) {
      logger.warn(`[BE:svc] recording lesson media=${media.id} not queued for processing — ${err.message}`);
    }
    return media.id;
  } catch (err) {
    logger.error(`[BE:svc] recording=${recording.id} saved, but no lesson was made — ${err.message}`);
    return null;
  }
};

// Long enough for a source reference or a question — the same ceiling the
// socket already puts on a chat message.
const CHAT_BODY_MAX = 2000;

/**
 * Keep one chat line for the lesson's appendix. The socket has already
 * established that the room is being recorded and that the writer's voice is
 * in it. Never throws: a chat message must reach the room whether or not it
 * could be kept.
 * @param {number} recordingId
 * @param {{ id: number, displayName?: string|null }} user
 * @param {string} text
 */
export const saveChatMessage = async (recordingId, user, text) => {
  try {
    await pool.query(
      `INSERT INTO session_recording_chat (recording_id, user_id, display_name, body)
       VALUES ($1, $2, $3, $4)`,
      [recordingId, user.id, user.displayName ?? null, String(text).slice(0, CHAT_BODY_MAX)]
    );
  } catch (err) {
    logger.warn(`[BE:svc] recording=${recordingId} chat line not kept — ${err.message}`);
  }
};

/**
 * A lesson's chat appendix: [{ name, text, at, offset }], or [] when it has none.
 * Visibility is the caller's to check first — the lesson's own rule.
 * @param {number|string} mediaId
 */
export const getLessonChat = async (mediaId) => {
  const { rows } = await pool.query("SELECT messages FROM media_session_chat WHERE media_id=$1", [mediaId]);
  return rows[0]?.messages ?? [];
};

/**
 * The host's "stop": close this recording with what arrived. Finishing one
 * already finished answers it as it is — the stop after a dropped answer.
 * @param {number|string} sessionId
 * @param {number|string} recordingId
 * @param {number} hostId
 * @param {{ trigger: (mediaId: number) => Promise<any> }} [lessonDeps]  the smoke check's stand-in for the queue
 */
export const finishRecording = async (sessionId, recordingId, hostId, lessonDeps = undefined) => {
  const recording = await recordingOfHost(recordingId, sessionId, hostId);
  if (recording.status !== "recording") return recording;
  return closeRecording(recording, lessonDeps);
};

/**
 * Close every recording of this session that is still open — when the session
 * ends, and before a new recording of it starts. Never throws: ending a
 * session must not fail because a recording could not be joined.
 * @param {number|string} sessionId
 */
export const finishOpenRecordings = async (sessionId) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${RECORDING_COLS} FROM session_recordings WHERE session_id=$1 AND status='recording'`,
      [sessionId]
    );
    const closed = [];
    for (const recording of rows) closed.push(await closeRecording(recording));
    return closed;
  } catch (err) {
    logger.error(`[BE:svc] finishOpenRecordings session=${sessionId} failed — ${err.message}`);
    return [];
  }
};

/**
 * A participant's answer, kept with the recording. The socket handler has
 * already established that the recording is the open one of the room the
 * participant is in.
 * @param {number} recordingId
 * @param {number} userId
 * @param {boolean} consented
 */
export const recordConsent = async (recordingId, userId, consented) => {
  await pool.query(
    `INSERT INTO session_recording_consents (recording_id, user_id, consented)
     VALUES ($1, $2, $3)
     ON CONFLICT (recording_id, user_id)
     DO UPDATE SET consented = EXCLUDED.consented, answered_at = NOW()`,
    [recordingId, userId, consented]
  );
};

/**
 * The answers already given for a recording, by user — so a participant whose
 * connection dropped is not asked again, and a host who reconnects does not
 * make the whole room answer twice.
 * @param {number} recordingId
 * @returns {Promise<Map<number, boolean>>}
 */
export const consentsFor = async (recordingId) => {
  const { rows } = await pool.query(
    "SELECT user_id, consented FROM session_recording_consents WHERE recording_id=$1",
    [recordingId]
  );
  return new Map(rows.map((r) => [Number(r.user_id), Boolean(r.consented)]));
};

/**
 * The open recording of the session behind a room, if `hostId` hosts it — what
 * the socket checks before telling a room that it is being recorded.
 * @param {number|string} recordingId
 * @param {string} roomToken
 * @param {number} hostId
 */
export const openRecordingInRoom = async (recordingId, roomToken, hostId) => {
  const { rows } = await pool.query(
    `SELECT r.id, r.session_id FROM session_recordings r
     JOIN live_sessions s ON s.id = r.session_id
     WHERE r.id=$1 AND s.room_token=$2 AND r.host_id=$3 AND r.status='recording' AND s.is_active`,
    [recordingId, roomToken, hostId]
  );
  return rows[0] ?? null;
};
