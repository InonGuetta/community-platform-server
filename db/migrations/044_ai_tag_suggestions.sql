-- Tags the LLM proposes for a lesson, waiting for whoever manages it to accept
-- or dismiss them (PRD ARCH-4).
--
-- Proposals, not tags: nothing here is shown in the archive or counted by a
-- filter. A proposal becomes a tag only when a person approves it, which moves
-- it into media_tags and deletes the row here; dismissing deletes it too.
--
-- Chosen only from the existing tree — tag_id is a foreign key, so the model
-- cannot invent a tag. `reason` is the model's one line on why, shown beside
-- the proposal so a person can judge it without opening the transcript.
--
-- CASCADE from both: a proposal means nothing once the lesson or the tag is gone.
-- The primary key leads with media_id and covers that foreign key; tag_id gets
-- its own index. TIMESTAMPTZ, like every new time column.
CREATE TABLE IF NOT EXISTS media_ai_tag_suggestions (
  media_id   INT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  tag_id     INT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (media_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_media_ai_tag_suggestions_tag ON media_ai_tag_suggestions(tag_id);
