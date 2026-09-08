// @ts-check
import { pool } from "../db/pool.js";
import { notFound, badRequest, conflict, ERROR_CODES } from "../lib/AppError.js";

const TITLE_MAX = 255; // matches VARCHAR(255)

// Counts come from the list query itself rather than a second round trip per
// course, so the management screen can show "how many students / how many
// lessons" without an N+1.
const LIST_COLUMNS = `
  c.*,
  u.display_name AS lecturer_name,
  (SELECT COUNT(*)::int FROM enrollments e WHERE e.course_id = c.id) AS student_count,
  (SELECT COUNT(*)::int FROM media_items m WHERE m.course_id = c.id) AS media_count`;

export const getAllCourses = async () => {
  const result = await pool.query(
    `SELECT ${LIST_COLUMNS}
     FROM courses c LEFT JOIN users u ON c.lecturer_id = u.id
     ORDER BY c.created_at DESC`
  );
  return result.rows;
};

export const getCourseById = async (id) => {
  const result = await pool.query(
    `SELECT ${LIST_COLUMNS}
     FROM courses c LEFT JOIN users u ON c.lecturer_id = u.id
     WHERE c.id=$1`,
    [id]
  );
  if (result.rows.length === 0) throw notFound("Course not found", ERROR_CODES.COURSE_NOT_FOUND);
  return result.rows[0];
};

// A course's lecturer must actually be a lecturer or an admin. Without this the
// field accepts any user id, including a student's, and the course then shows a
// student's name as the person teaching it.
const assertValidLecturer = async (lecturerId) => {
  if (lecturerId === undefined || lecturerId === null) return;
  const { rows } = await pool.query(
    "SELECT role FROM users WHERE id=$1 AND is_active=TRUE",
    [lecturerId]
  );
  if (rows.length === 0) throw badRequest("Lecturer not found");
  if (rows[0].role === "student") throw badRequest("A student cannot be a course lecturer");
};

const cleanTitle = (title) => {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (!trimmed) throw badRequest("Course title is required");
  if (trimmed.length > TITLE_MAX) throw badRequest(`Title must be at most ${TITLE_MAX} characters`);
  return trimmed;
};

export const createCourse = async (data) => {
  const { title, description, lecturerId } = data;
  const cleanedTitle = cleanTitle(title);
  await assertValidLecturer(lecturerId);

  const result = await pool.query(
    `INSERT INTO courses (title, description, lecturer_id)
     VALUES ($1, $2, $3) RETURNING *`,
    [cleanedTitle, description ?? null, lecturerId ?? null]
  );
  return getCourseById(result.rows[0].id);
};

export const updateCourse = async (id, data) => {
  const { title, description, lecturerId, isActive } = data;

  // COALESCE means "leave it alone when the field wasn't sent", matching how
  // updateUser and updateMedia already behave.
  const cleanedTitle = title === undefined || title === null ? null : cleanTitle(title);
  if (lecturerId !== undefined && lecturerId !== null) await assertValidLecturer(lecturerId);
  if (isActive !== undefined && isActive !== null && typeof isActive !== "boolean") {
    throw badRequest("isActive must be a boolean");
  }

  const result = await pool.query(
    `UPDATE courses SET
       title       = COALESCE($1, title),
       description = COALESCE($2, description),
       lecturer_id = COALESCE($3, lecturer_id),
       is_active   = COALESCE($4, is_active)
     WHERE id=$5 RETURNING id`,
    [cleanedTitle, description ?? null, lecturerId ?? null, isActive ?? null, id]
  );
  if (result.rows.length === 0) throw notFound("Course not found", ERROR_CODES.COURSE_NOT_FOUND);
  return getCourseById(id);
};

// Enrollments cascade away with the course; media does not — its course_id is
// set to NULL, which returns those lessons to the general library rather than
// deleting somebody's uploads along with the course.
export const deleteCourse = async (id) => {
  const result = await pool.query("DELETE FROM courses WHERE id=$1 RETURNING id", [id]);
  if (result.rows.length === 0) throw notFound("Course not found", ERROR_CODES.COURSE_NOT_FOUND);
  return { deleted: true, id: result.rows[0].id };
};

// ── Enrollments ─────────────────────────────────────────────────────────────

export const getCourseStudents = async (courseId) => {
  await getCourseById(courseId); // 404s for an unknown course instead of []
  const result = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.is_active, e.enrolled_at
     FROM enrollments e JOIN users u ON e.student_id = u.id
     WHERE e.course_id=$1
     ORDER BY u.display_name`,
    [courseId]
  );
  return result.rows;
};

// Just the ids, for the visibility rule. The full rows below are for a screen;
// this is for a WHERE clause, and shipping a dozen columns per course to build an
// int[] would be waste on every archive load.
//
// An empty array is a real answer — a student enrolled in nothing — and callers
// must treat it as such rather than as "unknown", which is what `null` means to
// the predicate this feeds.
export const getEnrolledCourseIds = async (studentId) => {
  const result = await pool.query(
    "SELECT course_id FROM enrollments WHERE student_id=$1",
    [studentId]
  );
  return result.rows.map((row) => Number(row.course_id));
};

// The courses one student belongs to, in full. This is what the "my courses"
// screen renders.
// media_count rides along for the same reason LIST_COLUMNS carries it: the card
// that renders one of these says how many lessons the course holds, and asking
// per card would be a request each. student_count is deliberately NOT here — a
// student has no business knowing who else is enrolled.
export const getStudentCourses = async (studentId) => {
  const result = await pool.query(
    `SELECT c.*, u.display_name AS lecturer_name, e.enrolled_at,
            (SELECT COUNT(*)::int FROM media_items m
              WHERE m.course_id = c.id AND m.is_published) AS media_count
     FROM enrollments e
     JOIN courses c ON e.course_id = c.id
     LEFT JOIN users u ON c.lecturer_id = u.id
     WHERE e.student_id=$1
     ORDER BY c.title`,
    [studentId]
  );
  return result.rows;
};

export const enrollStudent = async (courseId, studentId) => {
  await getCourseById(courseId);

  const { rows } = await pool.query(
    "SELECT role FROM users WHERE id=$1 AND is_active=TRUE",
    [studentId]
  );
  if (rows.length === 0) throw badRequest("Student not found");

  try {
    const result = await pool.query(
      `INSERT INTO enrollments (student_id, course_id) VALUES ($1, $2) RETURNING *`,
      [studentId, courseId]
    );
    return result.rows[0];
  } catch (err) {
    // The UNIQUE(student_id, course_id) index is the real guard against a double
    // enrollment; a pre-check would still lose a race between two admins.
    if (err?.code === "23505") throw conflict("Student is already enrolled in this course");
    throw err;
  }
};

export const unenrollStudent = async (courseId, studentId) => {
  const result = await pool.query(
    "DELETE FROM enrollments WHERE course_id=$1 AND student_id=$2 RETURNING id",
    [courseId, studentId]
  );
  if (result.rows.length === 0) throw notFound("Enrollment not found");
  return { removed: true, courseId: Number(courseId), studentId: Number(studentId) };
};

// ── The lecturer's own view of who learns with them ─────────────────────────

// Every distinct person enrolled in ANY course this lecturer teaches, with the
// courses each of them is in.
//
// Grouped rather than returned per enrolment, and that is the whole point: a
// student in three of this lecturer's courses is ONE student, not three rows.
// The ungrouped version reads as a roster of thirty when the lecturer has ten
// people, which is exactly the confusion this screen exists to remove.
//
// json_agg over a JOIN rather than a second query per student: the courses are
// wanted for every row, so N+1 would be N+1.
export const getStudentsOfLecturer = async (lecturerId) => {
  const result = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.is_active,
            COUNT(DISTINCT c.id)::int AS course_count,
            MIN(e.enrolled_at) AS first_enrolled_at,
            json_agg(
              json_build_object('id', c.id, 'title', c.title)
              ORDER BY c.title
            ) AS courses
     FROM courses c
     JOIN enrollments e ON e.course_id = c.id
     JOIN users u ON u.id = e.student_id
     WHERE c.lecturer_id = $1
     GROUP BY u.id, u.email, u.display_name, u.is_active
     ORDER BY u.display_name NULLS LAST, u.email`,
    [lecturerId]
  );
  return result.rows;
};

// ── Finding somebody to add ─────────────────────────────────────────────────

// Below this, the search answers nothing at all.
//
// This is the whole privacy design of the feature, and it is deliberately not a
// filter on role. A lecturer needs to add people by name, and the obvious way to
// let them — hand back the membership list — turns every approved lecturer into
// a holder of the community's address book. A search that refuses to answer a
// one-character query cannot be walked: "א" returns nothing, so there is no
// first page to page through.
const MIN_SEARCH_LENGTH = 2;

// And a ceiling, so a two-character query that matches half the membership still
// cannot be used to enumerate it.
const SEARCH_LIMIT = 20;

// Backslash is Postgres' default LIKE escape and has to escape itself first.
// Same treatment, and the same reason, as escapeLike in servicesMedia: % and _
// are wildcards to ILIKE and ordinary characters in a real name.
const escapeLike = (value) => String(value).replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * People this lecturer could add to this course.
 *
 * Deliberately NOT restricted to role='student'. Enrolling a lecturer in a
 * colleague's course is a documented, intended case — see the comments in the
 * client's App.jsx and Navbar.jsx — so filtering to students here would quietly
 * remove a capability the rest of the app assumes.
 *
 * Excluded instead: people already enrolled (adding them is a no-op that would
 * only produce a confusing 409), the course's own lecturer (enrolling yourself
 * in your own course means nothing), and deactivated accounts.
 */
export const searchEnrollableUsers = async (courseId, query) => {
  const term = typeof query === "string" ? query.trim() : "";
  // An empty answer, not an error: the caller is a search box that is still
  // being typed into, and a 400 per keystroke is noise, not a guard.
  if (term.length < MIN_SEARCH_LENGTH) return [];

  await getCourseById(courseId);

  const result = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.role
     FROM users u
     WHERE u.is_active = TRUE
       AND (u.display_name ILIKE $2 OR u.email ILIKE $2)
       AND NOT EXISTS (
         SELECT 1 FROM enrollments e
         WHERE e.course_id = $1 AND e.student_id = u.id
       )
       AND u.id <> COALESCE((SELECT lecturer_id FROM courses WHERE id = $1), 0)
     ORDER BY u.display_name NULLS LAST, u.email
     LIMIT $3`,
    [courseId, `%${escapeLike(term)}%`, SEARCH_LIMIT]
  );
  return result.rows;
};
