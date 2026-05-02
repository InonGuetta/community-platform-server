CREATE TYPE media_type AS ENUM ('video', 'audio', 'text');

CREATE TABLE media_items (
  id SERIAL PRIMARY KEY,
  uploader_id INT REFERENCES users(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  media_type media_type NOT NULL,
  s3_key TEXT NOT NULL,
  duration_seconds INT,
  thumbnail_url TEXT,
  is_published BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_media_uploader ON media_items(uploader_id);
CREATE INDEX idx_media_type ON media_items(media_type);
CREATE INDEX idx_media_published ON media_items(is_published);
