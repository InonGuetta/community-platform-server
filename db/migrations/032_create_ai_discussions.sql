-- The "דיון עם AI" tab: a student's conversation with the AI about ONE lesson.
--
-- ── Shape ───────────────────────────────────────────────────────────────────
--
-- A conversation belongs to one user and one lesson; its messages hang off it.
-- A user may have several conversations about the same lesson ("שיחה חדשה"
-- starts another and keeps the old one), and the tab opens the most recently
-- active — hence updated_at, which every new message moves forward.
--
-- Conversations are private. Nothing in the service reads one by id alone; every
-- read is by (user_id, media_id) of the caller, so not even an admin reads a
-- student's questions through this API.
--
-- ── ON DELETE, chosen per reference ─────────────────────────────────────────
--
--   user_id         CASCADE — a deleted account's questions are its own data,
--                   and keeping them orphaned would keep personal text with no
--                   owner to ever see or erase it.
--   media_id        CASCADE — a conversation ABOUT a lesson that no longer
--                   exists answers from text that no longer exists; its
--                   citations point at a timeline that is gone.
--   conversation_id CASCADE — a message is a part of its conversation.
--
-- ── Why citations are a SNAPSHOT, not a foreign key to transcript_chunks ────
--
-- An answer cites the passages it was built from ("[2] 12:34", "[3] עמ' 47").
-- The obvious column is a chunk_id — and it is the one this schema must not
-- have. services/transcripts/chunks.js → writeChunks DELETES every chunk of a
-- lesson and re-inserts them on each pipeline run, so a lecturer pressing
-- "הפק סיכום מחדש" would, through CASCADE, delete every answer ever given about
-- that lesson; through SET NULL, it would silently strip every citation.
-- (026_bookmark_text_ranges.sql is the same lesson, learnt on bookmarks.)
--
-- So `citations` stores what the reader needs, copied at the time the answer
-- was written: [{ n, chunk_index, start_time, end_time, page_number,
-- char_start, quote }]. A time in a recording and a page in a book are stable
-- facts about the ORIGINAL, which re-processing never moves — so the snapshot
-- keeps working exactly where a foreign key would have broken.
--
-- Every statement is idempotent: db/migrate.js re-runs every file on every
-- invocation.

CREATE TABLE IF NOT EXISTS ai_conversations (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id   INT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- The one read the tab makes: "this user's latest conversation on this lesson".
-- Also serves as user_id's foreign-key index (it leads).
CREATE INDEX IF NOT EXISTS idx_ai_conversations_user_media
  ON ai_conversations(user_id, media_id, updated_at DESC);

-- media_id's foreign-key index: deleting a lesson must find its conversations
-- without scanning every one on the platform.
CREATE INDEX IF NOT EXISTS idx_ai_conversations_media ON ai_conversations(media_id);

CREATE TABLE IF NOT EXISTS ai_messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role            VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  citations       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Messages are always read as one conversation, in order. Serves as the
-- foreign-key index too.
CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation ON ai_messages(conversation_id, id);
