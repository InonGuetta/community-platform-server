-- When a reader last opened each lesson — any kind of lesson, a book too.
--
-- watch_progress (005) answers "where did I stop in this recording", and the
-- archive's hero and the "המשך צפייה" shelf were built on it. But it has a row
-- only for something that PLAYED: a book opened and read, or a lesson page
-- looked at, left no trace, so "the last thing I was in" was really "the last
-- thing I played". This table is the visit itself: one row per (reader,
-- lesson), its time moved forward on every opening of the lesson page
-- (POST /api/media/:id/view). The history (GET /api/media/history) takes the
-- later of this and watch_progress.last_watched_at, so a lesson played from
-- the bottom player — which never opens the page — still counts.
--
-- ON DELETE CASCADE on both sides, chosen: a visit means nothing once the
-- reader's account or the lesson is gone, and nothing else refers to it.
-- The index on media_id is the rule for every foreign key (the primary key
-- covers user_id); the second index is the history's own order.
CREATE TABLE IF NOT EXISTS media_views (
  user_id        INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id       INTEGER     NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  last_viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, media_id)
);

CREATE INDEX IF NOT EXISTS media_views_media_id_idx ON media_views (media_id);
CREATE INDEX IF NOT EXISTS media_views_user_recent_idx ON media_views (user_id, last_viewed_at DESC);
