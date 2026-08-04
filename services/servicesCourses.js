// @ts-check
import { pool } from "../db/pool.js";
import { notFound, badRequest, conflict } from "../lib/AppError.js";

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
  if (result.rows.length === 0) throw notFound("Course not found");
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
  if (result.rows.length === 0) throw notFound("Course not found");
  return getCourseById(id);
};

// Enrollments cascade away with the course; media does not — its course_id is
// set to NULL, which returns those lessons to the general library rather than
// deleting somebody's uploads along with the course.
export const deleteCourse = async (id) => {
  const result = await pool.query("DELETE FROM courses WHERE id=$1 RETURNING id", [id]);
  if (result.rows.length === 0) throw notFound("Course not found");
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

// The courses one student belongs to. This is the query the media filter will
// eventually be built on, which is why it lives here rather than inline.
export const getStudentCourses = async (studentId) => {
  const result = await pool.query(
    `SELECT c.*, u.display_name AS lecturer_name, e.enrolled_at
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
