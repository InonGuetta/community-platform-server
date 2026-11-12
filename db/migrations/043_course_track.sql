-- A course as a track (PRD CRS-1, CRS-2, CRS-3): its lessons in an order the
-- lecturer chooses, how far each student has got through them, and the lesson
-- that comes next.

-- The order. NULL until the lecturer arranges the course, and for a lesson
-- added since: those follow the arranged ones, oldest first (the reading in
-- services/servicesCourseTrack.js), so a new lesson lands at the end of the
-- track rather than at an arbitrary place in it. Not unique: a lesson moved to
-- another course keeps its number until that course is arranged, and the order
-- breaks ties by date.
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS course_position INT;
CREATE INDEX IF NOT EXISTS idx_media_course_position ON media_items(course_id, course_position);

-- When the listener got through a lesson: the first time the saved position
-- reached 90% of its length. Kept apart from the position on purpose — listening
-- again from the start moves the position back to zero, and must not un-finish
-- a lesson somebody already finished. TIMESTAMPTZ, like every new time column.
ALTER TABLE watch_progress ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- What was already heard before this existed counts. Idempotent: it only fills
-- rows still empty, and the rule is the one saveWatchProgress applies from now
-- on. A lesson whose length was never measured cannot be judged and stays open.
-- last_watched_at is a zoneless TIMESTAMP written in UTC (see db/pool.js), so
-- it is read AS UTC rather than in whatever zone this session runs in.
UPDATE watch_progress wp
   SET completed_at = wp.last_watched_at AT TIME ZONE 'UTC'
  FROM media_items m
 WHERE m.id = wp.media_id
   AND wp.completed_at IS NULL
   AND m.duration_seconds > 0
   AND wp.last_position_seconds >= m.duration_seconds * 0.9;
