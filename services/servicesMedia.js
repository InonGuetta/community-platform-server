// @ts-check
import { pool } from "../db/pool.js";
import { notFound } from "../lib/AppError.js";

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
  ) AS has_transcript`;

const MEDIA_JOINS = `
  FROM media_items m
  LEFT JOIN users u ON m.uploader_id = u.id
  LEFT JOIN users l ON m.lecturer_id = l.id
  LEFT JOIN courses c ON m.course_id = c.id`;

export const getAllMedia = async (filters = {}) => {
  let query = `SELECT ${MEDIA_COLUMNS} ${MEDIA_JOINS} WHERE 1=1`;
  const params = [];

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
    params.push(`%${filters.search}%`);
    query += ` AND m.title ILIKE $${params.length}`;
  }

  query += " ORDER BY m.created_at DESC";
  const result = await pool.query(query, params);
  return result.rows;
};

export const getMediaById = async (id) => {
  const result = await pool.query(
    `SELECT ${MEDIA_COLUMNS} ${MEDIA_JOINS} WHERE m.id=$1`,
    [id]
  );
  if (result.rows.length === 0) throw notFound("Media not found");
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
  if (result.rows.length === 0) throw notFound("Media not found");
  return getMediaById(id);
};

export const deleteMedia = async (id) => {
  const result = await pool.query("DELETE FROM media_items WHERE id=$1 RETURNING id", [id]);
  if (result.rows.length === 0) throw notFound("Media not found");
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
