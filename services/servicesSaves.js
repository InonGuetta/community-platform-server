// @ts-check
import { pool } from "../db/pool.js";
import { visibleMediaSql } from "../lib/permissions.js";
import { notFound, badRequest, conflict, ERROR_CODES } from "../lib/AppError.js";

// The server's word on how long a list's name may be, and the only place this
// side states it: cleanTitle below is what every write goes through.
//
// The column is VARCHAR(120) to match. SQL cannot import this, so the migration
// carries a comment naming this constant — the pair has to be changed together,
// and a column that is narrower than the check would turn a clear 400 into a
// driver error.
const TITLE_MAX = 120;

// ── The general save ────────────────────────────────────────────────────────

// Both reads below take the SAME `visibleCourses`, and that is the point.
//
// They answer one question — "what has this user saved" — for two different
// consumers: the page that lists the cards, and the button that lights up on a
// lecture. When only the list filtered drafts out, the two disagreed: the button
// said נשמר on an item the page refused to show, and nothing the user could do
// reconciled them.
//
// The value is decided once, in the controller, by visibleCoursesFor(req.user) —
// the same helper that governs what the archive, the media page and the stream
// hand out. So a student sees the same items in both places, and a lecturer sees
// their own draft in both, including a lit button on it.

// The saved MEDIA rows, not the save rows: whatever screen lists these renders
// the same cards as the archive, so it needs what those cards read. `saved_at`
// rides along so the list can be ordered by when it was saved rather than when
// the lecture was uploaded.
//
// `in_list` says whether this user has also filed the lecture in one of their
// own lists. Filing something saves it (see addToPlaylist), so this list holds
// everything either way — and the saved-content page needs to tell the two apart
// or it shows each filed lecture twice: once loose at the top and again inside
// the list it belongs to. Answered here, next to the query it belongs to, rather
// than by the client fetching every list's contents to work it out.
export const getSavedMediaByUser = async (userId, visibleCourses = []) => {
  const result = await pool.query(
    `SELECT m.*, s.created_at AS saved_at,
            EXISTS (
              SELECT 1 FROM playlist_items pi
              JOIN playlists p ON p.id = pi.playlist_id
              WHERE p.user_id = s.user_id AND pi.media_id = m.id
            ) AS in_list
     FROM saved_items s
     JOIN media_items m ON m.id = s.media_id
     WHERE s.user_id = $1 AND ${visibleMediaSql("$2")}
     ORDER BY s.created_at DESC`,
    [userId, visibleCourses]
  );
  return result.rows;
};

// Just the ids, for the button's own state. Shipped as one set rather than a
// request per lecture, small enough to hold in the client store. The join exists
// only for the visibility test — without it this cannot apply the same rule as
// the query above, which is what let the two drift apart.
export const getSavedMediaIds = async (userId, visibleCourses = []) => {
  const result = await pool.query(
    `SELECT s.media_id
     FROM saved_items s
     JOIN media_items m ON m.id = s.media_id
     WHERE s.user_id = $1 AND ${visibleMediaSql("$2")}`,
    [userId, visibleCourses]
  );
  return result.rows.map((r) => r.media_id);
};

// Idempotent by way of UNIQUE(user_id, media_id): saving an already-saved item
// is a no-op rather than a duplicate row or a 500.
export const addSave = async (userId, mediaId) => {
  await pool.query(
    "INSERT INTO saved_items (user_id, media_id) VALUES ($1, $2) ON CONFLICT (user_id, media_id) DO NOTHING",
    [userId, mediaId]
  );
  return { saved: true, mediaId };
};

// Unsaving also drops the lecture from every list this user has put it in.
//
// The alternative — leaving it in the lists — produces a lecture that the save
// button calls unsaved while it is still sitting in "לשבת", which is not a state
// anyone asked for and cannot be explained in the UI. The general save is the
// container; a list is a grouping inside it (see addToPlaylist, which creates
// the general save alongside the membership), so removing the container removes
// what it held.
//
// One transaction: a half-done unsave would leave exactly the orphan this is
// here to prevent. Other users' lists are untouched — the subquery is scoped to
// this user's playlists.
export const removeSave = async (userId, mediaId) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM saved_items WHERE user_id=$1 AND media_id=$2", [userId, mediaId]);
    await client.query(
      `DELETE FROM playlist_items
       WHERE media_id = $2
         AND playlist_id IN (SELECT id FROM playlists WHERE user_id = $1)`,
      [userId, mediaId]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  // Deliberately not a 404 when there was nothing to delete: "unsave something I
  // have not saved" has already arrived at the state the caller wanted.
  return { saved: false, mediaId };
};

// ── The user's own lists ────────────────────────────────────────────────────

const cleanTitle = (title) => {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (!trimmed) throw badRequest("List title is required");
  if (trimmed.length > TITLE_MAX) throw badRequest(`Title must be at most ${TITLE_MAX} characters`);
  return trimmed;
};

// Every list this user owns, newest first.
//
// `mediaId` is optional and is what the save menu opens with: it answers "which
// of my lists already hold this lecture" in the same round trip as "what are my
// lists", because the menu cannot draw a single checkbox without both. Passing
// NULL leaves `contains` false throughout, which is the right answer for a
// caller that is not looking at a particular lecture.
export const getPlaylists = async (userId, mediaId = null) => {
  const result = await pool.query(
    `SELECT p.*,
            (SELECT COUNT(*)::int FROM playlist_items pi WHERE pi.playlist_id = p.id) AS item_count,
            EXISTS (
              SELECT 1 FROM playlist_items pi
              WHERE pi.playlist_id = p.id AND pi.media_id = $2
            ) AS contains
     FROM playlists p
     WHERE p.user_id = $1
     ORDER BY p.created_at DESC`,
    [userId, mediaId]
  );
  return result.rows;
};

// ONE list and what is in it, for the page that opens a list of its own.
//
// The title comes back with the rows rather than being left to the caller to
// find: that page can be reached by its URL alone, with nothing else loaded, and
// a heading is the first thing it has to draw. Missing or someone else's is
// reported the same way as everywhere here — a list that is not yours does not
// exist, which is both true from the caller's side and the safe thing to say.
//
// Same visibility rule as the flat saved list, from the same flag: a lecture the
// user may not see is not shown because it happens to sit in a list of theirs.
export const getPlaylistWithMedia = async (userId, playlistId, visibleCourses = []) => {
  const { rows } = await pool.query(
    "SELECT * FROM playlists WHERE id=$1 AND user_id=$2",
    [playlistId, userId]
  );
  if (rows.length === 0) throw notFound("List not found", ERROR_CODES.NOT_FOUND);

  const items = await pool.query(
    `SELECT m.*, pi.added_at
     FROM playlist_items pi
     JOIN media_items m ON m.id = pi.media_id
     WHERE pi.playlist_id = $1 AND ${visibleMediaSql("$2")}
     ORDER BY pi.added_at DESC`,
    [playlistId, visibleCourses]
  );
  return { ...rows[0], item_count: items.rows.length, items: items.rows };
};

// `mediaId` is optional and is what the save menu passes: a list made from the
// menu exists in order to hold the lecture in front of the user, so creating it
// and filing that lecture is ONE act and belongs in one transaction.
//
// It used to be two requests from the client, and the failure mode was the
// reason to change it: when the second one failed, the user was left with an
// empty list they never asked for and no way to tell what had happened.
//
// The UNIQUE(user_id, title) is reported as a conflict rather than allowed to
// surface as a driver error: "you already have a list called that" is something
// the user can act on, and 23505 is not. It carries its own code because the
// client can say something precise about this one — see ERROR_CODES.
export const createPlaylist = async (userId, title, mediaId = null) => {
  const cleanedTitle = cleanTitle(title);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      "INSERT INTO playlists (user_id, title) VALUES ($1, $2) RETURNING *",
      [userId, cleanedTitle]
    );
    const playlist = result.rows[0];

    if (mediaId) {
      // Same pair as addToPlaylist: filing a lecture also saves it, because the
      // general save is the container every list is a grouping inside.
      await client.query(
        "INSERT INTO saved_items (user_id, media_id) VALUES ($1, $2) ON CONFLICT (user_id, media_id) DO NOTHING",
        [userId, mediaId]
      );
      await client.query(
        "INSERT INTO playlist_items (playlist_id, media_id) VALUES ($1, $2)",
        [playlist.id, mediaId]
      );
    }

    await client.query("COMMIT");
    // Shaped like the rows getPlaylists returns, so the client can drop it
    // straight into the same list without a refetch.
    return { ...playlist, item_count: mediaId ? 1 : 0, contains: Boolean(mediaId) };
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") {
      throw conflict("A list with that name already exists", ERROR_CODES.PLAYLIST_TITLE_TAKEN);
    }
    throw err;
  } finally {
    client.release();
  }
};

// Renaming, which is the only thing about a list that can be edited — its
// contents are changed through the membership calls below.
//
// Scoped to the owner in the UPDATE itself, like every other write here: a list
// belonging to someone else matches nothing and is reported as missing, which is
// both true from the caller's side and the safe thing to say.
//
// Same 23505 → conflict translation as createPlaylist, and for the same reason:
// UNIQUE(user_id, title) is a rule the user can act on ("you already have a list
// called that"), and a driver error is not. Renaming a list to the name it
// already has does NOT trip it — Postgres does not compare a row with itself.
export const renamePlaylist = async (userId, playlistId, title) => {
  const cleanedTitle = cleanTitle(title);
  try {
    const result = await pool.query(
      `UPDATE playlists SET title = $3
       WHERE id = $1 AND user_id = $2
       RETURNING *,
                 (SELECT COUNT(*)::int FROM playlist_items pi WHERE pi.playlist_id = playlists.id) AS item_count`,
      [playlistId, userId, cleanedTitle]
    );
    if (result.rows.length === 0) throw notFound("List not found", ERROR_CODES.NOT_FOUND);
    return result.rows[0];
  } catch (err) {
    if (err.code === "23505") {
      throw conflict("A list with that name already exists", ERROR_CODES.PLAYLIST_TITLE_TAKEN);
    }
    throw err;
  }
};

// Ownership is checked by scoping the write to the user rather than by reading
// the row first and comparing: one statement, and no window between the check
// and the delete. A list belonging to someone else is indistinguishable from one
// that does not exist, which is also the right thing to tell the caller.
const assertOwnedPlaylist = async (client, userId, playlistId) => {
  const { rows } = await client.query(
    "SELECT id FROM playlists WHERE id=$1 AND user_id=$2",
    [playlistId, userId]
  );
  if (rows.length === 0) throw notFound("List not found", ERROR_CODES.NOT_FOUND);
};

export const deletePlaylist = async (userId, playlistId) => {
  const result = await pool.query(
    "DELETE FROM playlists WHERE id=$1 AND user_id=$2 RETURNING id",
    [playlistId, userId]
  );
  if (result.rows.length === 0) throw notFound("List not found", ERROR_CODES.NOT_FOUND);
  // playlist_items cascades from the FK; the general save is left alone, since
  // discarding a grouping is not the same as discarding what it grouped.
  return { deleted: true, playlistId };
};

// Adding to a list also creates the general save, in the same transaction.
//
// That is the model this feature is built on: the general save is everything the
// user keeps, and a list is a named subset of it. Without this, a lecture put
// straight into a list would sit there while the save button showed unsaved —
// the button would be lying about the only thing it says.
export const addToPlaylist = async (userId, playlistId, mediaId) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertOwnedPlaylist(client, userId, playlistId);
    await client.query(
      "INSERT INTO saved_items (user_id, media_id) VALUES ($1, $2) ON CONFLICT (user_id, media_id) DO NOTHING",
      [userId, mediaId]
    );
    await client.query(
      "INSERT INTO playlist_items (playlist_id, media_id) VALUES ($1, $2) ON CONFLICT (playlist_id, media_id) DO NOTHING",
      [playlistId, mediaId]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { playlistId, mediaId, contains: true };
};

// Taking it out of one list does NOT unsave it: the user said where to file it,
// not whether to keep it. It stays in the general save and in any other list.
export const removeFromPlaylist = async (userId, playlistId, mediaId) => {
  const result = await pool.query(
    `DELETE FROM playlist_items pi
     USING playlists p
     WHERE pi.playlist_id = p.id
       AND p.user_id = $1 AND p.id = $2 AND pi.media_id = $3
     RETURNING pi.id`,
    [userId, playlistId, mediaId]
  );
  // Same as removeSave: nothing to remove is already the state the caller asked
  // for. A list that is not theirs simply matches nothing, which is why this
  // needs no separate ownership read.
  return { playlistId, mediaId, contains: false, removed: result.rows.length > 0 };
};
