// @ts-check
import { randomUUID } from "crypto";
import { pool } from "../db/pool.js";
import { notFound, forbidden, badRequest, ERROR_CODES } from "../lib/AppError.js";

// The three states a session can be in, derived rather than stored — see
// migration 018 for why there is no status column. Selected as a label so the
// client never has to reconstruct it from two nullable timestamps, which is the
// sort of logic that ends up written differently on the list and on the room.
const SESSION_COLUMNS = `
  s.*,
  u.display_name AS host_name,
  CASE
    WHEN NOT s.is_active            THEN 'ended'
    WHEN s.started_at IS NOT NULL   THEN 'live'
    ELSE 'scheduled'
  END AS state`;

const SESSION_JOINS = `
  FROM live_sessions s
  LEFT JOIN users u ON s.host_id = u.id`;

export const createSession = async (hostId, data) => {
  const { title, sessionType, maxParticipants, scheduledAt } = data;
  const roomToken = randomUUID();
  // A session with no scheduled time starts immediately, which is exactly what
  // this always did — so the existing "start a room now" flow is unchanged.
  // Given a time, it is created dormant: started_at stays NULL until the host
  // opens it.
  const result = await pool.query(
    `INSERT INTO live_sessions
       (host_id, title, session_type, room_token, max_participants, is_active, scheduled_at, started_at)
     VALUES ($1, $2, $3, $4, $5, TRUE, $6, CASE WHEN $6::timestamp IS NULL THEN NOW() ELSE NULL END)
     RETURNING *`,
    [hostId, title, sessionType, roomToken, maxParticipants, scheduledAt]
  );
  return getSessionById(result.rows[0].id);
};

// Live now: begun and not finished. This is what the room list has always shown.
export const getActiveSessions = async () => {
  const result = await pool.query(
    `SELECT ${SESSION_COLUMNS} ${SESSION_JOINS}
     WHERE s.is_active = TRUE AND s.started_at IS NOT NULL
     ORDER BY s.started_at DESC`
  );
  return result.rows;
};

// Scheduled and not yet begun. Ordered soonest first, which is the opposite of
// the live list and is the right answer for both: a live room is interesting
// because it just opened, an upcoming one because it is next.
//
// Sessions whose scheduled time has passed without the host opening them are
// still listed. Hiding them would make a host who is five minutes late look to
// everyone else like a host who never scheduled anything.
export const getUpcomingSessions = async () => {
  const result = await pool.query(
    `SELECT ${SESSION_COLUMNS} ${SESSION_JOINS}
     WHERE s.is_active = TRUE AND s.started_at IS NULL
     ORDER BY s.scheduled_at ASC NULLS LAST`
  );
  return result.rows;
};

export const getSessionById = async (id) => {
  const result = await pool.query(
    `SELECT ${SESSION_COLUMNS} ${SESSION_JOINS} WHERE s.id=$1`,
    [id]
  );
  if (result.rows.length === 0) throw notFound("Session not found", ERROR_CODES.SESSION_NOT_FOUND);
  return result.rows[0];
};

// Opening a scheduled room. Host-only, enforced in the WHERE clause like every
// other write here, so there is no window between deciding and acting.
//
// `started_at IS NULL` makes it idempotent in the direction that matters: a host
// clicking twice does not reset the clock on a room people are already in.
export const startSession = async (id, hostId) => {
  const result = await pool.query(
    `UPDATE live_sessions SET started_at = NOW()
     WHERE id=$1 AND host_id=$2 AND is_active = TRUE AND started_at IS NULL
     RETURNING id`,
    [id, hostId]
  );
  if (result.rows.length === 0) {
    // Either not the host, or already started, or ended. Distinguishing them
    // would tell a non-host about the state of a session they do not run.
    const existing = await getSessionById(id);
    if (Number(existing.host_id) !== Number(hostId)) {
      throw forbidden("Only the host can start this session", ERROR_CODES.SESSION_FORBIDDEN);
    }
    if (!existing.is_active) throw badRequest("This session has already ended");
    return existing; // already live — the state the caller wanted
  }
  return getSessionById(id);
};

// The socket layer knows a room by its token, not its id.
export const getSessionByRoomToken = async (roomToken) => {
  const result = await pool.query("SELECT * FROM live_sessions WHERE room_token=$1", [roomToken]);
  return result.rows[0] || null;
};

// The room token for a session this caller is entitled to enter.
//
// It exists because the token is no longer sent to the client: it used to travel
// on every row of the sessions list, which meant the thing the architecture calls
// "the capability" was handed to everybody who could see the list — including for
// sessions that had already ended, alongside recording_s3_key. Now the client
// asks by id, the server decides, and the token stays server-side.
//
// The rule is deliberately the same one that was in force before, stated out
// loud for the first time: any signed-in user may enter a live session. What has
// changed is that it is now a decision this function makes rather than a
// consequence of who happened to be holding a string.
export const getJoinableRoomToken = async (id, _userId) => {
  const session = await getSessionById(id);
  if (!session.is_active) {
    throw badRequest("This session has ended", ERROR_CODES.SESSION_NOT_FOUND);
  }
  if (!session.started_at) {
    throw badRequest("This session has not started yet", ERROR_CODES.SESSION_NOT_STARTED);
  }
  return { roomToken: session.room_token, session };
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
  if (result.rows.length === 0) throw forbidden("Session not found or not authorized", ERROR_CODES.SESSION_FORBIDDEN);
  return result.rows[0];
};
