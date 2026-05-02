import { pool } from "../db/pool.js";

export const getBookmarksByUser = async (userId, mediaId) => {
  let query = "SELECT * FROM bookmarks WHERE user_id=$1";
  const params = [userId];
  if (mediaId) {
    params.push(mediaId);
    query += ` AND media_id=$${params.length}`;
  }
  query += " ORDER BY timestamp_seconds ASC";
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
  if (result.rows.length === 0) throw new Error("Bookmark not found");
  return result.rows[0];
};

export const deleteBookmark = async (id, userId) => {
  const result = await pool.query(
    "DELETE FROM bookmarks WHERE id=$1 AND user_id=$2 RETURNING id",
    [id, userId]
  );
  if (result.rows.length === 0) throw new Error("Bookmark not found");
  return { deleted: true, id };
};
