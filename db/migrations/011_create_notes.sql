-- Personal notebook: free-form notes owned by a single user. A note may
-- optionally hang off a lecture + timestamp (created from the media player),
-- but stands on its own. Deleting the linked media only nulls the link so the
-- user's writing is never lost.
CREATE TABLE notes (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(200),
  body TEXT,
  media_id INT REFERENCES media_items(id) ON DELETE SET NULL,
  timestamp_seconds INT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_notes_user ON notes(user_id);
