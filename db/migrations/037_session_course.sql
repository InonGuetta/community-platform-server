-- A live session can belong to a course (PRD D8, decided 2026-11-02).
--
-- Until this a session belonged to nobody: anyone signed in could join any
-- session, and nothing recorded who it was FOR. Notifications (NOTIF-2,
-- migration 036) had to guess an audience, and guessed "the host's students" —
-- everybody in any course the host teaches, which over-reaches as soon as a
-- lecturer teaches two courses and schedules a session for one of them.
--
-- With a course, the session's notices go to that course's students. Without
-- one, they go to the host's students, as before — a general session still
-- reaches the people the host teaches. Joining is unchanged: this column says
-- whom to TELL, not who may enter.
--
-- ── ON DELETE SET NULL ──────────────────────────────────────────────────────
--
-- Deleting a course must not delete the sessions held for it — the history of
-- what was taught live is not the course's to take with it. The session simply
-- becomes a general one. Nullable for the same reason, and because every
-- session before this has no course.
--
-- Indexed: it is a foreign key, and deleting a course looks its sessions up.
--
-- Idempotent, like every migration here: db/migrate.js re-runs every file.

ALTER TABLE live_sessions
  ADD COLUMN IF NOT EXISTS course_id INT REFERENCES courses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_live_sessions_course ON live_sessions(course_id);
