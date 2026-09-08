// @ts-check
import { pool } from "../db/pool.js";
import { visibleMediaSql } from "../lib/permissions.js";

// Both reads below take the SAME `visibleCourses`, decided once in the
// controller by visibleCoursesFor(req.user) — the helper that already governs
// what the archive, the media page and the stream hand out.
//
// Previously only the first of the two filtered drafts, so the two disagreed:
// the button said אהבתי on an item the likes page refused to show, and a
// lecturer's own draft could never light its button at all (the row was already
// there, so pressing again was a no-op). One flag for both keeps the answer the
// same wherever it is asked. See servicesSaves.js, which has the same pair.

// Returns the liked MEDIA rows, not the like rows: the likes page renders the
// same cards as the archive, so it needs what those cards read (title, type,
// publish state, ownership). `liked_at` rides along so the list can be ordered
// by when the user liked it rather than when the lecture was uploaded.
// `scope` is { courses, drafts } from viewerScopeFor — the two halves travel
// TOGETHER, as one argument, on purpose. Passed separately, a call site that
// remembered one and forgot the other would compile, run, and quietly widen or
// narrow what is returned.
export const getLikedMediaByUser = async (userId, scope = { courses: [], drafts: [] }) => {
  const result = await pool.query(
    `SELECT m.*, l.created_at AS liked_at
     FROM likes l
     JOIN media_items m ON m.id = l.media_id
     WHERE l.user_id = $1 AND ${visibleMediaSql("$2", "m", "$3")}
     ORDER BY l.created_at DESC`,
    [userId, scope.courses, scope.drafts]
  );
  return result.rows;
};

// Just the media ids. The media page needs to know whether ONE item is liked,
// and the archive would need it for many; shipping the id set once is cheaper
// than a per-item request and is small enough to hold in the client store. The
// join exists only for the visibility test.
export const getLikedMediaIds = async (userId, scope = { courses: [], drafts: [] }) => {
  const result = await pool.query(
    `SELECT l.media_id
     FROM likes l
     JOIN media_items m ON m.id = l.media_id
     WHERE l.user_id = $1 AND ${visibleMediaSql("$2", "m", "$3")}`,
    [userId, scope.courses, scope.drafts]
  );
  return result.rows.map((r) => r.media_id);
};

// Idempotent by way of the UNIQUE(user_id, media_id) constraint: liking an
// already-liked item is a no-op rather than a duplicate row or a 500. The
// caller gets the same shape either way, so it never has to care which happened.
export const addLike = async (userId, mediaId) => {
  await pool.query(
    "INSERT INTO likes (user_id, media_id) VALUES ($1, $2) ON CONFLICT (user_id, media_id) DO NOTHING",
    [userId, mediaId]
  );
  return { liked: true, mediaId };
};

// Deliberately not a 404 when there was nothing to delete. "Unlike something I
// have not liked" has already arrived at the state the caller wanted, and a
// double-click on the button should not surface an error.
export const removeLike = async (userId, mediaId) => {
  await pool.query("DELETE FROM likes WHERE user_id=$1 AND media_id=$2", [userId, mediaId]);
  return { liked: false, mediaId };
};
