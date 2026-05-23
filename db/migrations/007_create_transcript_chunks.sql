-- transcript_chunks is created in 004_create_transcripts.sql (the source of truth).
-- This migration only upgrades older databases whose 004 predates that table:
--   1. drop the legacy transcripts columns that chunks replaced
--   2. create transcript_chunks if it isn't there yet
-- All statements are idempotent, so on a fresh DB this is a clean no-op
-- (no swallowed "already exists" errors).

ALTER TABLE transcripts DROP COLUMN IF EXISTS raw_text;
ALTER TABLE transcripts DROP COLUMN IF EXISTS segments;

CREATE TABLE IF NOT EXISTS transcript_chunks (
  id          SERIAL PRIMARY KEY,
  media_id    INT REFERENCES media_items(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  start_time  INT NOT NULL,
  end_time    INT NOT NULL,
  content     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_media ON transcript_chunks(media_id);
CREATE INDEX IF NOT EXISTS idx_chunks_fts ON transcript_chunks
  USING GIN(to_tsvector('simple', content));
