CREATE TYPE transcript_status AS ENUM ('pending', 'processing', 'done', 'error');

CREATE TABLE transcripts (
  id          SERIAL PRIMARY KEY,
  media_id    INT REFERENCES media_items(id) ON DELETE CASCADE UNIQUE,
  edited_text TEXT,
  status      transcript_status DEFAULT 'pending',
  ai_summary  TEXT,
  ai_chapters JSONB,
  ai_key_points JSONB,
  updated_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_transcripts_media ON transcripts(media_id);

CREATE TABLE transcript_chunks (
  id          SERIAL PRIMARY KEY,
  media_id    INT REFERENCES media_items(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  start_time  INT NOT NULL,
  end_time    INT NOT NULL,
  content     TEXT NOT NULL
);

CREATE INDEX idx_chunks_media ON transcript_chunks(media_id);
CREATE INDEX idx_chunks_fts ON transcript_chunks
  USING GIN(to_tsvector('simple', content));
