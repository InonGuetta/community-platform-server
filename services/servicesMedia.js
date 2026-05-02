import { pool } from "../db/pool.js";

export const getAllMedia = async (filters = {}) => {
  let query = `SELECT m.*, u.display_name AS uploader_name
    FROM media_items m LEFT JOIN users u ON m.uploader_id = u.id
    WHERE 1=1`;
  const params = [];

  if (filters.type) {
    params.push(filters.type);
    query += ` AND m.media_type=$${params.length}`;
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
    `SELECT m.*, u.display_name AS uploader_name
     FROM media_items m LEFT JOIN users u ON m.uploader_id = u.id
     WHERE m.id=$1`,
    [id]
  );
  if (result.rows.length === 0) throw new Error("Media not found");
  return result.rows[0];
};

export const createMedia = async (data) => {
  const { uploaderId, title, description, mediaType, s3Key, durationSeconds, thumbnailUrl } = data;
  const result = await pool.query(
    `INSERT INTO media_items (uploader_id, title, description, media_type, s3_key, duration_seconds, thumbnail_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [uploaderId, title, description, mediaType, s3Key, durationSeconds, thumbnailUrl]
  );
  return result.rows[0];
};

export const updateMedia = async (id, data) => {
  const { title, description, isPublished, thumbnailUrl, durationSeconds } = data;
  const result = await pool.query(
    `UPDATE media_items SET
      title = COALESCE($1, title),
      description = COALESCE($2, description),
      is_published = COALESCE($3, is_published),
      thumbnail_url = COALESCE($4, thumbnail_url),
      duration_seconds = COALESCE($5, duration_seconds)
    WHERE id=$6 RETURNING *`,
    [title, description, isPublished, thumbnailUrl, durationSeconds, id]
  );
  if (result.rows.length === 0) throw new Error("Media not found");
  return result.rows[0];
};

export const deleteMedia = async (id) => {
  const result = await pool.query("DELETE FROM media_items WHERE id=$1 RETURNING id", [id]);
  if (result.rows.length === 0) throw new Error("Media not found");
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
