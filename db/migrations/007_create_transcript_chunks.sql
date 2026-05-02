ALTER TABLE transcripts DROP COLUMN IF EXISTS raw_text;
ALTER TABLE transcripts DROP COLUMN IF EXISTS segments;

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
