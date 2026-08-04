// @ts-check
import { pool } from "../db/pool.js";

// Returns the liked MEDIA rows, not the like rows: the likes page renders the
// same cards as the archive, so it needs what those cards read (title, type,
// publish state, ownership). `liked_at` rides along so the list can be ordered
// by when the user liked it rather than when the lecture was uploaded.
//
// Unpublished items are filtered out. An item can be liked and then withdrawn
// from publication, and the archive would no longer show it — leaving it here
// would make the likes page the one screen that still hands it out.
export const getLikedMediaByUser = async (userId) => {
  const result = await pool.query(
    `SELECT m.*, l.created_at AS liked_at
     FROM likes l
     JOIN media_items m ON m.id = l.media_id
     WHERE l.user_id = $1 AND m.is_published = TRUE
     ORDER BY l.created_at DESC`,
    [userId]
  );
  return result.rows;
};

// Just the media ids. The media page needs to know whether ONE item is liked,
// and the archive would need it for many; shipping the id set once is cheaper
// than a per-item request and is small enough to hold in the client store.
export const getLikedMediaIds = async (userId) => {
  const result = await pool.query("SELECT media_id FROM likes WHERE user_id=$1", [userId]);
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
