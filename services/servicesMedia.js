// @ts-check
import { pool } from "../db/pool.js";
import { visibleMediaSql } from "../lib/permissions.js";
import { notFound, ERROR_CODES } from "../lib/AppError.js";

// The course and the teaching lecturer travel with every media row so the
// archive can label a card without a second request per item. `lecturer_name`
// falls back to the uploader: most existing items have no lecturer_id, and
// showing nothing there reads as missing data rather than "not recorded yet".
// `has_transcript` rides along so an archive card can decide whether to offer
// "download transcript" without a request per card. EXISTS rather than a join:
// the answer is a boolean and joining transcript_chunks would multiply the media
// rows. It asks for actual content — a transcripts row can exist while still
// pending or failed, and offering a download that produces an empty file is
// worse than not offering it.
const MEDIA_COLUMNS = `
  m.*,
  u.display_name AS uploader_name,
  c.title AS course_title,
  COALESCE(l.display_name, u.display_name) AS lecturer_name,
  (
    EXISTS (SELECT 1 FROM transcript_chunks tc WHERE tc.media_id = m.id)
    OR EXISTS (
      SELECT 1 FROM transcripts t
      WHERE t.media_id = m.id AND COALESCE(t.edited_text, '') <> ''
    )
  ) AS has_transcript,
  -- How many people liked this. Until now a like was recorded and then only ever
  -- read back to the person who left it, so the button lit up for them and told
  -- nobody else anything: a lecturer had no way to know a lecture had landed, and
  -- an archive of hundreds gave no signal about which of them anyone valued.
  -- Aliased lk, not l — l is already the lecturer join above, and a subquery
  -- reusing it would silently resolve against the outer scope.
  (SELECT COUNT(*)::int FROM likes lk WHERE lk.media_id = m.id) AS like_count`;

const MEDIA_JOINS = `
  FROM media_items m
  LEFT JOIN users u ON m.uploader_id = u.id
  LEFT JOIN users l ON m.lecturer_id = l.id
  LEFT JOIN courses c ON m.course_id = c.id`;

// What the user typed is a phrase to find, not a pattern to match with.
//
// The value is a bound parameter, so this was never an injection — but ILIKE
// reads % and _ as wildcards wherever they appear, and they appear in real
// titles. A search for "100%" matched every title starting "100", and one for
// "פרק_ב" matched "פרקאב". Backslash is Postgres' default LIKE escape, and it
// has to escape itself first or a title containing one would consume the
// character after it.
const escapeLike = (value) => String(value).replace(/[\\%_]/g, (char) => `\\${char}`);

export const getAllMedia = async (filters = {}) => {
  // The visibility rule opens the WHERE clause rather than being one more
  // optional `if` below, and that is the point: it is not a filter the caller
  // may or may not supply, it is the condition under which any of these rows may
  // be returned at all. `WHERE 1=1` with the rule as an optional addition put it
  // one forgotten argument away from listing the whole library.
  // Annotated because the elements are of mixed type: without it the array
  // infers from its first element and every push below is an error.
  //
  // `=== undefined` and NOT `??`, and the difference is the whole rule. null is a
  // meaningful value here — it is how "unrestricted" is spelled — so `?? []`
  // silently rewrote every lecturer and admin into someone enrolled in nothing,
  // emptying the archive of every course lesson and every draft for exactly the
  // people who are supposed to see them. Only an ABSENT argument may fail closed.
  //
  // The same distinction updateMedia draws with `"courseId" in body`, and
  // optionalSeconds with zero: presence is not the same question as value.
  /** @type {Array<string|number|boolean|number[]|null>} */
  const params = [filters.visibleCourses === undefined ? [] : filters.visibleCourses];
  let query = `SELECT ${MEDIA_COLUMNS} ${MEDIA_JOINS} WHERE ${visibleMediaSql("$1")}`;

  if (filters.type) {
    params.push(filters.type);
    query += ` AND m.media_type=$${params.length}`;
  }
  if (filters.courseId !== undefined) {
    params.push(filters.courseId);
    query += ` AND m.course_id=$${params.length}`;
  }
  if (filters.published !== undefined) {
    params.push(filters.published);
    query += ` AND m.is_published=$${params.length}`;
  }
  if (filters.search) {
    params.push(`%${escapeLike(filters.search)}%`);
    query += ` AND m.title ILIKE $${params.length}`;
  }

  query += " ORDER BY m.created_at DESC";
  const result = await pool.query(query, params);
  return result.rows;
};

// "Carry on where you left off" — the watch history, newest first.
//
// Built on MEDIA_COLUMNS and MEDIA_JOINS rather than its own column list, because
// what it returns is rendered by the same cards as the archive: a second list
// here would drift, and the symptom would be a shelf whose cards quietly lost
// their course label or their download button.
//
// The visibility rule applies to it like everything else, and here it earns its
// keep twice over: a lecture watched before the student was unenrolled — or
// before it was unpublished — drops off the shelf instead of sitting there as a
// card that 404s when clicked.
//
// A position of zero is excluded rather than shown: there is nothing to carry on
// from, and the row exists only because the player reported a position once.
export const getContinueWatching = async (userId, visibleCourses, limit = 12) => {
  const result = await pool.query(
    `SELECT ${MEDIA_COLUMNS},
            wp.last_position_seconds,
            wp.last_watched_at
     ${MEDIA_JOINS}
     JOIN watch_progress wp ON wp.media_id = m.id
     WHERE wp.user_id = $1
       AND wp.last_position_seconds > 0
       AND ${visibleMediaSql("$2")}
     ORDER BY wp.last_watched_at DESC
     LIMIT $3`,
    [userId, visibleCourses, limit]
  );
  return result.rows;
};

export const getMediaById = async (id) => {
  const result = await pool.query(
    `SELECT ${MEDIA_COLUMNS} ${MEDIA_JOINS} WHERE m.id=$1`,
    [id]
  );
  if (result.rows.length === 0) throw notFound("Media not found", ERROR_CODES.MEDIA_NOT_FOUND);
  return result.rows[0];
};

export const createMedia = async (data) => {
  const { uploaderId, title, description, mediaType, s3Key, durationSeconds, thumbnailUrl, courseId, lecturerId } = data;
  const result = await pool.query(
    `INSERT INTO media_items (uploader_id, title, description, media_type, s3_key, duration_seconds, thumbnail_url, course_id, lecturer_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [uploaderId, title, description, mediaType, s3Key, durationSeconds, thumbnailUrl, courseId ?? null, lecturerId ?? null]
  );
  return result.rows[0];
};

// course_id and lecturer_id use CASE rather than COALESCE, unlike every field
// above them. COALESCE cannot express "set this to NULL": it reads a null
// parameter as "leave it alone", which is right for a title and wrong for an
// association — removing a lesson from a course would be impossible. The
// accompanying booleans say whether the caller mentioned the field at all, which
// is the distinction COALESCE throws away.
export const updateMedia = async (id, data) => {
  const {
    title, description, isPublished, thumbnailUrl, durationSeconds,
    courseId, lecturerId, setCourse = false, setLecturer = false,
  } = data;
  const result = await pool.query(
    `UPDATE media_items SET
      title = COALESCE($1, title),
      description = COALESCE($2, description),
      is_published = COALESCE($3, is_published),
      thumbnail_url = COALESCE($4, thumbnail_url),
      duration_seconds = COALESCE($5, duration_seconds),
      course_id = CASE WHEN $6::boolean THEN $7::int ELSE course_id END,
      lecturer_id = CASE WHEN $8::boolean THEN $9::int ELSE lecturer_id END
    WHERE id=$10 RETURNING *`,
    [title, description, isPublished, thumbnailUrl, durationSeconds,
      setCourse, courseId ?? null, setLecturer, lecturerId ?? null, id]
  );
  if (result.rows.length === 0) throw notFound("Media not found", ERROR_CODES.MEDIA_NOT_FOUND);
  return getMediaById(id);
};

export const deleteMedia = async (id) => {
  const result = await pool.query("DELETE FROM media_items WHERE id=$1 RETURNING id", [id]);
  if (result.rows.length === 0) throw notFound("Media not found", ERROR_CODES.MEDIA_NOT_FOUND);
  return { deleted: true, id };
};

export const saveWatchProgress = async (userId, mediaId, positionSeconds) => {
  const result = await pool.query(
    `INSERT INTO watch_progress (user_id, media_id, last_position_seconds, last_watched_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, media_id)
     DO UPDATE SET last_position_seconds=$3, last_watched_at=NOW()
     RETURNING *`,
    [userId, mediaId, positionSeconds]
  );
  return result.rows[0];
};

export const getWatchProgress = async (userId, mediaId) => {
  const result = await pool.query(
    "SELECT * FROM watch_progress WHERE user_id=$1 AND media_id=$2",
    [userId, mediaId]
  );
  return result.rows[0] || null;
};
