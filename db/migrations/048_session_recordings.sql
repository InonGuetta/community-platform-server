-- Recording a live session (PRD REC-1; services/servicesSessionRecordings.js).
--
-- The mesh sends media peer to peer and the server never sees it, so the only
-- place a session can be recorded is the host's browser: it mixes the audio of
-- everyone who agreed to be recorded and uploads it in numbered parts while the
-- session runs. One row per recording; the parts themselves are files on disk
-- until the recording is finished and joined into one file (local or S3).
--
--   recording  parts are arriving
--   finished   joined into one file — s3_key is set (also copied to
--              live_sessions.recording_s3_key, the column 003 kept for this)
--   failed     finished with nothing usable (no parts arrived)
--
-- One open recording per session (the partial unique index): starting again
-- after the host's tab was reloaded closes the previous one first.
CREATE TABLE IF NOT EXISTS session_recordings (
  id          SERIAL PRIMARY KEY,
  session_id  INT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  host_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      VARCHAR(16) NOT NULL DEFAULT 'recording'
              CHECK (status IN ('recording', 'finished', 'failed')),
  mime_type   VARCHAR(100) NOT NULL,
  parts       INT NOT NULL DEFAULT 0,
  bytes       BIGINT NOT NULL DEFAULT 0,
  s3_key      TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_session_recordings_session ON session_recordings(session_id);
CREATE INDEX IF NOT EXISTS idx_session_recordings_host ON session_recordings(host_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_recordings_open
  ON session_recordings(session_id) WHERE status = 'recording';

-- Who was asked, and what they answered (PRD REC-1, "הסכמה מפורשת"). The
-- record of consent is kept with the recording it was given for — the host's
-- browser mixes in only those who said yes, and this is the evidence of who
-- did. The latest answer wins: a participant may withdraw, and their audio is
-- left out from that moment.
CREATE TABLE IF NOT EXISTS session_recording_consents (
  recording_id INT NOT NULL REFERENCES session_recordings(id) ON DELETE CASCADE,
  user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consented    BOOLEAN NOT NULL,
  answered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (recording_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_session_recording_consents_user ON session_recording_consents(user_id);
