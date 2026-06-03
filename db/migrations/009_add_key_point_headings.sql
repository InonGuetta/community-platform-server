-- Stores the "subheadings by key points" feature output: the existing
-- ai_key_points mapped onto the transcript timeline as clickable headings.
-- Shape: [{ "title": "...", "start_time": 123 }, ...] ordered by start_time.
-- Idempotent so re-running the migrator on an existing DB is a clean no-op.
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS ai_key_point_headings JSONB;
