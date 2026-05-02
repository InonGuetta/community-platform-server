CREATE TYPE session_type AS ENUM ('1on1', 'group', 'webinar');

CREATE TABLE live_sessions (
  id SERIAL PRIMARY KEY,
  host_id INT REFERENCES users(id),
  title VARCHAR(255),
  session_type session_type NOT NULL,
  room_token TEXT UNIQUE NOT NULL,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  recording_s3_key TEXT,
  max_participants INT,
  is_active BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_sessions_host ON live_sessions(host_id);
CREATE INDEX idx_sessions_active ON live_sessions(is_active);
