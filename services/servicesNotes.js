// @ts-check
import { pool } from "../db/pool.js";
import { notFound, ERROR_CODES } from "../lib/AppError.js";

// Notes are joined to media so the client can show which lecture a note came
// from (title) without a second round-trip. media_title is null for free notes.
const SELECT_WITH_MEDIA = `
  SELECT n.*, m.title AS media_title
  FROM notes n
  LEFT JOIN media_items m ON m.id = n.media_id
`;

// The order the OWNER put the notes in — see migration 019. It was
// updated_at DESC, which meant fixing a typo in the oldest note threw it to the
// top of the notebook; a notebook the user can arrange has to keep its
// arrangement across an edit.
//
// id DESC is the tie-break and not decoration: two notes can share a sort_order
// (a reorder that raced a create, or rows that predate a first reorder), and
// without a second key Postgres is free to return them in a different order on
// every request — a list that reshuffles itself on refresh with nothing to
// blame it on.
const NOTE_ORDER = "ORDER BY n.sort_order ASC, n.id DESC";

export const getNotesByUser = async (userId) => {
  const result = await pool.query(
    `${SELECT_WITH_MEDIA} WHERE n.user_id=$1 ${NOTE_ORDER}`,
    [userId]
  );
  return result.rows;
};

export const createNote = async (userId, { title, body, mediaId, timestampSeconds }) => {
  const result = await pool.query(
    // A new note goes to the TOP, which is where the client has always shown it
    // and where the user is about to start typing. One below the smallest the
    // user has, rather than a renumbering of every other row: this is a single
    // INSERT and stays one however large the notebook is. The COALESCE covers
    // the first note in an empty notebook.
    `INSERT INTO notes (user_id, title, body, media_id, timestamp_seconds, sort_order)
     VALUES ($1, $2, $3, $4, $5,
             COALESCE((SELECT MIN(sort_order) FROM notes WHERE user_id=$1), 1) - 1)
     RETURNING *`,
    [userId, title ?? null, body ?? null, mediaId ?? null, timestampSeconds ?? null]
  );
  return result.rows[0];
};

/**
 * Write a new order for a user's notes: `ids` in the order they are to appear.
 *
 * One statement rather than a query per note, because the client sends the whole
 * list on every drag — a loop would be N round-trips for one gesture, and a
 * partial failure halfway through would leave the notebook in an order nobody
 * chose.
 *
 * `user_id` in the WHERE is the authorisation: an id belonging to somebody else
 * matches nothing and is silently skipped, so a forged list can reorder only
 * what the caller already owns. The count comes back so the controller can say
 * how many rows the reorder actually touched.
 *
 * updated_at is deliberately NOT bumped. Moving a note is not editing it, and
 * the notebook shows "last updated" on every card.
 */
export const reorderNotes = async (userId, ids) => {
  const result = await pool.query(
    // `ord` rather than `position`: WITH ORDINALITY's counter is a bigint and
    // the column is an int, and the alias avoids naming a column after a
    // Postgres function while we are at it.
    `UPDATE notes SET sort_order = ranked.ord::int
     FROM unnest($2::int[]) WITH ORDINALITY AS ranked(id, ord)
     WHERE notes.id = ranked.id AND notes.user_id = $1
     RETURNING notes.id`,
    [userId, ids]
  );
  return { reordered: result.rows.length };
};

export const updateNote = async (id, userId, { title, body }) => {
  const result = await pool.query(
    `UPDATE notes SET title=$1, body=$2, updated_at=NOW()
     WHERE id=$3 AND user_id=$4 RETURNING *`,
    [title ?? null, body ?? null, id, userId]
  );
  if (result.rows.length === 0) throw notFound("Note not found", ERROR_CODES.NOTE_NOT_FOUND);
  return result.rows[0];
};

export const deleteNote = async (id, userId) => {
  const result = await pool.query(
    "DELETE FROM notes WHERE id=$1 AND user_id=$2 RETURNING id",
    [id, userId]
  );
  if (result.rows.length === 0) throw notFound("Note not found", ERROR_CODES.NOTE_NOT_FOUND);
  return { deleted: true, id };
};
