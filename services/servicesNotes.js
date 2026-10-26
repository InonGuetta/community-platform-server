// @ts-check
import { pool } from "../db/pool.js";
import { notFound, badRequest, ERROR_CODES } from "../lib/AppError.js";
import { visibleMediaSql } from "../lib/permissions.js";

// Notes are joined to media so the client can show which lecture a note came
// from (title) without a second round-trip. media_title is null for free notes.
//
// The TYPE comes with it, and it is not decoration: the notebook draws an icon
// beside "מתוך: <שיעור>", and with only a title to go on it drew a play triangle
// for every note — including notes taken on a filmed shiur and on a sefer. Both
// columns are null together for a free note, so the client has one condition to
// check rather than two.
//
// The title only while the caller may still see the lecture — the same rule
// servicesBookmarks.getBookmarksByUser applies, for the same reason: the note
// was attached while the lecture was visible, and an unenrolment or an
// unpublish later must not keep handing its title back. The note itself stays.
const SELECT_WITH_MEDIA = `
  SELECT n.*,
         CASE WHEN ${visibleMediaSql("$2", "m", "$3")} THEN m.title END AS media_title,
         m.media_type AS media_type
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

// `scope` fails closed like every other read: absent means "may see nothing".
export const getNotesByUser = async (userId, scope = { courses: [], drafts: [] }) => {
  const result = await pool.query(
    `${SELECT_WITH_MEDIA} WHERE n.user_id=$1 ${NOTE_ORDER}`,
    [userId, scope.courses, scope.drafts]
  );
  return result.rows;
};

// The column is VARCHAR(200) (011); the body is TEXT and holds pasted images as
// base64 (RichNoteEditor caps each at 3MB). Without a cap, one note could fill
// the whole 20MB request and then be returned in full on every notebook load.
export const NOTE_TITLE_MAX = 200;
export const NOTE_BODY_MAX = 15 * 1024 * 1024;

// undefined/null pass through as null, which the UPDATE below reads as "leave
// it alone" and the INSERT stores as empty.
const cleanNoteField = (value, name, max) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw badRequest(`${name} must be text`);
  if (value.length > max) throw badRequest(`${name} is too long`);
  return value;
};

// The body is stored as the client sent it, deliberately not re-sanitised here.
// It is HTML, but it is only ever rendered back to its OWNER, and the client
// runs it through sanitizeNoteHtml on every load (noteBodyToHtml) — the one
// allowlist, tested against the source chips it must preserve. A second,
// server-side allowlist written in a different library would have to match it
// attribute for attribute, and the first mismatch silently strips a chip out of
// somebody's notes on save.
export const createNote = async (userId, { title, body, mediaId, timestampSeconds }) => {
  title = cleanNoteField(title, "title", NOTE_TITLE_MAX);
  body = cleanNoteField(body, "body", NOTE_BODY_MAX);
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

// COALESCE, like every other update here: a field left out of the body is left
// alone. It used to be written as NULL, so a client sending only {body} wiped the
// title. Clearing a field is sending "" — which is not null and is stored.
export const updateNote = async (id, userId, { title, body }) => {
  const result = await pool.query(
    `UPDATE notes SET title=COALESCE($1, title), body=COALESCE($2, body), updated_at=NOW()
     WHERE id=$3 AND user_id=$4 RETURNING *`,
    [cleanNoteField(title, "title", NOTE_TITLE_MAX), cleanNoteField(body, "body", NOTE_BODY_MAX), id, userId]
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
