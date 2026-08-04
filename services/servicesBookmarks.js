// @ts-check
import { pool } from "../db/pool.js";
import { notFound } from "../lib/AppError.js";

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

export const createBookmark = async (userId, mediaId, timestampSeconds, note) => {
  const result = await pool.query(
    "INSERT INTO bookmarks (user_id, media_id, timestamp_seconds, note) VALUES ($1, $2, $3, $4) RETURNING *",
    [userId, mediaId, timestampSeconds, note]
  );
  return result.rows[0];
};

export const updateBookmark = async (id, userId, note) => {
  const result = await pool.query(
    "UPDATE bookmarks SET note=$1 WHERE id=$2 AND user_id=$3 RETURNING *",
    [note, id, userId]
  );
  if (result.rows.length === 0) throw notFound("Bookmark not found");
  return result.rows[0];
};

export const deleteBookmark = async (id, userId) => {
  const result = await pool.query(
    "DELETE FROM bookmarks WHERE id=$1 AND user_id=$2 RETURNING id",
    [id, userId]
  );
  if (result.rows.length === 0) throw notFound("Bookmark not found");
  return { deleted: true, id };
};
