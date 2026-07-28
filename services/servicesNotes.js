import { pool } from "../db/pool.js";
import { notFound } from "../lib/AppError.js";

// Notes are joined to media so the client can show which lecture a note came
// from (title) without a second round-trip. media_title is null for free notes.
const SELECT_WITH_MEDIA = `
  SELECT n.*, m.title AS media_title
  FROM notes n
  LEFT JOIN media_items m ON m.id = n.media_id
`;

export const getNotesByUser = async (userId) => {
  const result = await pool.query(
    `${SELECT_WITH_MEDIA} WHERE n.user_id=$1 ORDER BY n.updated_at DESC`,
    [userId]
  );
  return result.rows;
};

export const createNote = async (userId, { title, body, mediaId, timestampSeconds }) => {
  const result = await pool.query(
    `INSERT INTO notes (user_id, title, body, media_id, timestamp_seconds)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, title ?? null, body ?? null, mediaId ?? null, timestampSeconds ?? null]
  );
  return result.rows[0];
};

export const updateNote = async (id, userId, { title, body }) => {
  const result = await pool.query(
    `UPDATE notes SET title=$1, body=$2, updated_at=NOW()
     WHERE id=$3 AND user_id=$4 RETURNING *`,
    [title ?? null, body ?? null, id, userId]
  );
  if (result.rows.length === 0) throw notFound("Note not found");
  return result.rows[0];
};

export const deleteNote = async (id, userId) => {
  const result = await pool.query(
    "DELETE FROM notes WHERE id=$1 AND user_id=$2 RETURNING id",
    [id, userId]
  );
  if (result.rows.length === 0) throw notFound("Note not found");
  return { deleted: true, id };
};
