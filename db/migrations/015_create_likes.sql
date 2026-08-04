-- A "like" is a plain user↔media pair: there is nothing to edit about one, only
-- to add or remove. Hence the UNIQUE constraint rather than an updatable row —
-- a double-click, or the same lecture opened in two tabs, must not be able to
-- leave two likes behind. The ON CONFLICT DO NOTHING in the service depends on
-- it, so liking twice is idempotent instead of an error.
CREATE TABLE likes (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  media_id INT REFERENCES media_items(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, media_id)
);

-- The two reads this table gets: "everything this user liked" (the likes page,
-- newest first) and "did this user like this item" (the button's own state).
-- Both start from user_id, and the UNIQUE index above already covers the second.
CREATE INDEX idx_likes_user_created ON likes(user_id, created_at DESC);
