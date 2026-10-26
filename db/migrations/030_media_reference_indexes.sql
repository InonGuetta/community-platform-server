-- Indexes for the per-media lookups the archive runs on every row it returns.
--
-- MEDIA_COLUMNS in services/servicesMedia.js computes like_count with a
-- correlated subquery — `FROM likes lk WHERE lk.media_id = m.id` — once per media
-- row on every archive load. likes has only UNIQUE(user_id, media_id) and
-- (user_id, created_at); neither LEADS with media_id, so Postgres cannot use them
-- for that lookup and scans likes once per card.
--
-- watch_progress and saved_items have the same shape: their only index on the
-- column starts with user_id, and both are also reached by media_id — the cascade
-- when a media item is deleted, and the "continue watching" / saved-list joins.
-- Rule 4 of this directory (an index on every foreign key) was missed for all
-- three when the tables were created (005, 015, 016).
--
-- Plain CREATE INDEX IF NOT EXISTS: safe on every re-run.
CREATE INDEX IF NOT EXISTS idx_likes_media ON likes(media_id);
CREATE INDEX IF NOT EXISTS idx_watch_progress_media ON watch_progress(media_id);
CREATE INDEX IF NOT EXISTS idx_saved_items_media ON saved_items(media_id);
