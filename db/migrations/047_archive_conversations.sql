-- A conversation with the whole archive rather than one lesson (PRD ASK-2;
-- services/discussion/archive.js).
--
-- Stored in the same two tables as the lesson chat (migration 032), so the
-- daily question quota — counted from ai_messages through ai_conversations by
-- user — counts both with no change, and deleting a user still takes both.
-- An archive conversation is simply one with no lesson: media_id NULL.
--
-- Safe for every existing statement: the lesson paths all select by
-- `media_id = $n`, which is never true of NULL, so no lesson view can reach an
-- archive conversation. ON DELETE CASCADE on media_id is unchanged and does not
-- touch a NULL.
ALTER TABLE ai_conversations ALTER COLUMN media_id DROP NOT NULL;

-- The one read the archive chat makes: "this user's latest archive
-- conversation". Partial, because the lesson rows already have their own
-- (user_id, media_id, updated_at) index.
CREATE INDEX IF NOT EXISTS idx_ai_conversations_user_archive
  ON ai_conversations(user_id, updated_at DESC)
  WHERE media_id IS NULL;
