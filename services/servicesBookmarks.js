// @ts-check
import { pool } from "../db/pool.js";
import { notFound, ERROR_CODES } from "../lib/AppError.js";

// Joined to media so the notebook can show which lecture each bookmark came
// from without a request per bookmark. Ordering by title first groups a
// cross-lecture list by lecture; for the media-scoped call every row shares one
// title, so it collapses to the timestamp ordering NotesPanel relies on.
export const getBookmarksByUser = async (userId, mediaId) => {
  let query = `
    SELECT b.*, m.title AS media_title, m.media_type
    FROM bookmarks b
    LEFT JOIN media_items m ON m.id = b.media_id
    WHERE b.user_id=$1`;
  const params = [userId];
  if (mediaId) {
    params.push(mediaId);
    query += ` AND b.media_id=$${params.length}`;
  }
  query += " ORDER BY m.title NULLS LAST, b.timestamp_seconds ASC";
  const result = await pool.query(query, params);
  return result.rows;
};

// Returns the same shape getBookmarksByUser does — media_title and media_type
// included. A bare RETURNING * gives back only the bookmarks columns, and the
// client appends that row straight into the list it already holds; in the
// notebook, which groups every bookmark under its lecture, a row missing the
// title landed in a group headed "שיעור" in the neutral grey instead of under
// the lecture it belongs to, and stayed wrong until the next reload.
export const createBookmark = async (userId, mediaId, timestampSeconds, note) => {
  const result = await pool.query(
    `WITH inserted AS (
       INSERT INTO bookmarks (user_id, media_id, timestamp_seconds, note)
       VALUES ($1, $2, $3, $4)
       RETURNING *
     )
     SELECT b.*, m.title AS media_title, m.media_type
     FROM inserted b
     LEFT JOIN media_items m ON m.id = b.media_id`,
    [userId, mediaId, timestampSeconds, note]
  );
  return result.rows[0];
};

export const updateBookmark = async (id, userId, note) => {
  const result = await pool.query(
    "UPDATE bookmarks SET note=$1 WHERE id=$2 AND user_id=$3 RETURNING *",
    [note, id, userId]
  );
  if (result.rows.length === 0) throw notFound("Bookmark not found", ERROR_CODES.BOOKMARK_NOT_FOUND);
  return result.rows[0];
};

export const deleteBookmark = async (id, userId) => {
  const result = await pool.query(
    "DELETE FROM bookmarks WHERE id=$1 AND user_id=$2 RETURNING id",
    [id, userId]
  );
  if (result.rows.length === 0) throw notFound("Bookmark not found", ERROR_CODES.BOOKMARK_NOT_FOUND);
  return { deleted: true, id };
};
