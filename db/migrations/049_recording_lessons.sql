-- A session's recording becomes a lesson, with its chat kept as an appendix
-- (PRD REC-2, REC-3; services/servicesSessionRecordings.js → lessonFromRecording).
--
-- The chat of a room is not stored (sockets/socketManager.js: "a session is a
-- conversation, not a record"). The one exception is a room being RECORDED,
-- and then only what was written by someone whose voice is in the recording —
-- the host and those who said yes. They agreed to the session becoming a
-- lesson; the others did not, and their messages are never kept.
CREATE TABLE IF NOT EXISTS session_recording_chat (
  id           SERIAL PRIMARY KEY,
  recording_id INT NOT NULL REFERENCES session_recordings(id) ON DELETE CASCADE,
  -- SET NULL: a deleted account's message stays in the appendix under the name
  -- it was written with, like a quote in a lesson's transcript.
  user_id      INT REFERENCES users(id) ON DELETE SET NULL,
  display_name VARCHAR(255),
  body         TEXT NOT NULL,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_session_recording_chat_recording ON session_recording_chat(recording_id, id);
CREATE INDEX IF NOT EXISTS idx_session_recording_chat_user ON session_recording_chat(user_id);

-- Which session a lesson was recorded in. SET NULL: deleting the session (an
-- old one, cleaned up) must not delete the lesson made from it.
ALTER TABLE media_items
  ADD COLUMN IF NOT EXISTS session_id INT REFERENCES live_sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_media_items_session ON media_items(session_id);

-- Which lesson a recording became — so finishing twice cannot make two, and
-- the host's "stop" can link to it. SET NULL: deleting the lesson leaves the
-- record of the recording.
ALTER TABLE session_recordings
  ADD COLUMN IF NOT EXISTS media_id INT REFERENCES media_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_session_recordings_media ON session_recordings(media_id);

-- The appendix itself: the chat COPIED onto the lesson when it is made —
-- [{ name, text, at }] — the same "copied, never referenced" rule as a chat
-- citation (migration 032). Its own table rather than a column on media_items,
-- because every archive listing reads media_items.* and a long chat would ride
-- along on every card. Read only on the lesson page (GET /media/:id/session-chat).
CREATE TABLE IF NOT EXISTS media_session_chat (
  media_id   INT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
  messages   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
