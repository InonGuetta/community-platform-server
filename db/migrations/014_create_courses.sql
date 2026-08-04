-- Courses, enrollments, and the two associations media has been missing.
--
-- Everything here is IF NOT EXISTS because db/migrate.js re-runs every file on
-- every invocation and only skips a statement when Postgres answers "already
-- exists". A plain CREATE/ALTER would make the second migration run noisy at
-- best and, for the ALTERs, an outright error.

CREATE TABLE IF NOT EXISTS courses (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  -- The lecturer responsible for the course. SET NULL rather than CASCADE: a
  -- lecturer leaving must not delete the course and orphan its students.
  lecturer_id INT REFERENCES users(id) ON DELETE SET NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_courses_lecturer ON courses(lecturer_id);
CREATE INDEX IF NOT EXISTS idx_courses_active ON courses(is_active);

-- Which students may see which course. CASCADE on both sides is correct here
-- and only here: an enrollment is meaningless once either end is gone.
CREATE TABLE IF NOT EXISTS enrollments (
  id SERIAL PRIMARY KEY,
  student_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  enrolled_at TIMESTAMP DEFAULT NOW(),
  -- Without this a student enrolled twice is duplicated by every JOIN that
  -- reaches through this table, which silently multiplies their media list.
  UNIQUE (student_id, course_id)
);

CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_course ON enrollments(course_id);

-- Both nullable, deliberately.
--
-- course_id NULL means "general library" — visible to every student, the way the
-- whole archive is today. Making it NOT NULL would have hidden all 16 existing
-- items the moment this ran.
--
-- lecturer_id is separate from uploader_id on purpose: uploader_id records who
-- pressed the button, which is not the same as who taught. Every item currently
-- in the library was uploaded by the admin, so uploader_id cannot stand in for
-- attribution.
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS course_id INT REFERENCES courses(id) ON DELETE SET NULL;
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS lecturer_id INT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_media_course ON media_items(course_id);
CREATE INDEX IF NOT EXISTS idx_media_lecturer ON media_items(lecturer_id);
