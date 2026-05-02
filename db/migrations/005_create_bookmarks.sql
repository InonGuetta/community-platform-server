CREATE TABLE bookmarks (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  media_id INT REFERENCES media_items(id) ON DELETE CASCADE,
  timestamp_seconds INT NOT NULL,
  note TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_bookmarks_user_media ON bookmarks(user_id, media_id);

CREATE TABLE watch_progress (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  media_id INT REFERENCES media_items(id) ON DELETE CASCADE,
  last_position_seconds INT,
  last_watched_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, media_id)
);
