-- Joining a course by its code (PRD ROST-9): the lecturer hands out a short
-- code, a student types it in, and the lecturer approves.
--
-- Until this a student reached a course only by the lecturer finding them in
-- the type-ahead and adding them one at a time, which does not grow past a few
-- dozen people.

-- NULL means joining by code is off for this course — the state every existing
-- course starts in, so nobody can join one before its lecturer decides to allow
-- it. Six characters from an alphabet with no look-alikes (servicesCourses.js →
-- newJoinCode); unique across the platform, since a code alone names the course.
-- A UNIQUE index allows any number of NULLs, which is what "off" needs.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS join_code VARCHAR(16);
CREATE UNIQUE INDEX IF NOT EXISTS idx_courses_join_code ON courses(join_code);

-- One request per person per course. Typing the code again after a refusal
-- re-opens the same row rather than piling up new ones in the lecturer's queue.
--
-- CASCADE from the course and from the requester: a request has no meaning once
-- either is gone. decided_by is SET NULL — the decision stands when the
-- lecturer's account is removed, it just no longer names them.
--
-- TIMESTAMPTZ, like every time column since migration 035.
CREATE TABLE IF NOT EXISTS course_join_requests (
  id          SERIAL PRIMARY KEY,
  course_id   INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      VARCHAR(16) NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at  TIMESTAMPTZ,
  decided_by  INT REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT course_join_requests_status CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT course_join_requests_once UNIQUE (course_id, user_id)
);

-- course_id is the leading column of the UNIQUE above, which serves it as an
-- index; the other two foreign keys get their own.
CREATE INDEX IF NOT EXISTS idx_course_join_requests_user ON course_join_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_course_join_requests_decided_by ON course_join_requests(decided_by);
