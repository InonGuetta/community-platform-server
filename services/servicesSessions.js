import { randomUUID } from "crypto";
import { pool } from "../db/pool.js";

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
  if (result.rows.length === 0) throw new Error("Session not found");
  return result.rows[0];
};

export const endSession = async (id, hostId) => {
  const result = await pool.query(
    "UPDATE live_sessions SET is_active=FALSE, ended_at=NOW() WHERE id=$1 AND host_id=$2 RETURNING *",
    [id, hostId]
  );
  if (result.rows.length === 0) throw new Error("Session not found or not authorized");
  return result.rows[0];
};

export const saveRecording = async (id, hostId, s3Key) => {
  const result = await pool.query(
    "UPDATE live_sessions SET recording_s3_key=$1 WHERE id=$2 AND host_id=$3 RETURNING *",
    [s3Key, id, hostId]
  );
  if (result.rows.length === 0) throw new Error("Session not found or not authorized");
  return result.rows[0];
};
