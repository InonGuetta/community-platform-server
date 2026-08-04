// @ts-check
import { randomUUID } from "crypto";
import { pool } from "../db/pool.js";
import { notFound, forbidden } from "../lib/AppError.js";

export const createSession = async (hostId, data) => {
  const { title, sessionType, maxParticipants } = data;
  const roomToken = randomUUID();
  const result = await pool.query(
    `INSERT INTO live_sessions (host_id, title, session_type, room_token, max_participants, is_active, started_at)
     VALUES ($1, $2, $3, $4, $5, TRUE, NOW())
     RETURNING *`,
    [hostId, title, sessionType, roomToken, maxParticipants]
  );
  return result.rows[0];
};

export const getActiveSessions = async () => {
  const result = await pool.query(
    `SELECT s.*, u.display_name AS host_name
     FROM live_sessions s LEFT JOIN users u ON s.host_id = u.id
     WHERE s.is_active=TRUE ORDER BY s.started_at DESC`
  );
  return result.rows;
};

export const getSessionById = async (id) => {
  const result = await pool.query(
    `SELECT s.*, u.display_name AS host_name
     FROM live_sessions s LEFT JOIN users u ON s.host_id = u.id
     WHERE s.id=$1`,
    [id]
  );
  if (result.rows.length === 0) throw notFound("Session not found");
  return result.rows[0];
};

// The socket layer knows a room by its token, not its id.
export const getSessionByRoomToken = async (roomToken) => {
  const result = await pool.query("SELECT * FROM live_sessions WHERE room_token=$1", [roomToken]);
  return result.rows[0] || null;
};

// One statement does both the authorization and the state change: the WHERE
// clause IS the "only the host may end this" check, so there is no window
// between deciding and acting. Returns null when the caller isn't the host.
export const endSessionByRoomToken = async (roomToken, hostId) => {
  const result = await pool.query(
    `UPDATE live_sessions SET is_active=FALSE, ended_at=NOW()
     WHERE room_token=$1 AND host_id=$2 RETURNING *`,
    [roomToken, hostId]
  );
  return result.rows[0] || null;
};

export const endSession = async (id, hostId) => {
  const result = await pool.query(
    "UPDATE live_sessions SET is_active=FALSE, ended_at=NOW() WHERE id=$1 AND host_id=$2 RETURNING *",
    [id, hostId]
  );
  if (result.rows.length === 0) throw forbidden("Session not found or not authorized");
  return result.rows[0];
};

export const saveRecording = async (id, hostId, s3Key) => {
  const result = await pool.query(
    "UPDATE live_sessions SET recording_s3_key=$1 WHERE id=$2 AND host_id=$3 RETURNING *",
    [s3Key, id, hostId]
  );
  if (result.rows.length === 0) throw forbidden("Session not found or not authorized");
  return result.rows[0];
};
