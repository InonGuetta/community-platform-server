// @ts-check
// Joining a course by its code (PRD ROST-9, migration 042).
//
// The lecturer turns a code on for a course and hands it out; a student types
// it in, which files a REQUEST; the lecturer approves it, which enrols them.
// The code alone never enrols anybody — a code passed around a WhatsApp group
// reaches people the lecturer did not mean, and the approval is where that is
// caught.
//
// Its own file rather than more of servicesCourses.js: a request has a life of
// its own (pending, approved, refused, re-opened), and the courses service is
// about the course and its roster.
import { randomInt } from "node:crypto";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/transaction.js";
import { notFound, badRequest, conflict, ERROR_CODES } from "../lib/AppError.js";
import { getCourseById } from "./servicesCourses.js";

// No 0/O, 1/I/L: a code is read aloud in a class and copied off a board.
export const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const JOIN_CODE_LENGTH = 6;

// 31^6 ≈ 887 million codes. With the per-user limit on POST /courses/join a
// guess finds a course about never — and finding one only files a request the
// lecturer still has to approve.
export const newJoinCode = (random = randomInt) =>
  Array.from({ length: JOIN_CODE_LENGTH }, () => JOIN_CODE_ALPHABET[random(JOIN_CODE_ALPHABET.length)]).join("");

// What a person types: any case, spaces or a dash in the middle ("abc-234").
// Null for something that cannot be a code, so the lookup is never even run.
export const normaliseJoinCode = (raw) => {
  const code = String(raw ?? "").toUpperCase().replace(/[\s-]+/g, "");
  return /^[A-Z0-9]{4,16}$/.test(code) ? code : null;
};

// A fresh code for this course — turning joining on, or replacing a code that
// went further than it should have. The old one stops working at once.
// Retried on the (vanishingly rare) collision with another course's code; the
// UNIQUE index is the guard, not a lookup first.
export const setJoinCode = async (courseId) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const { rows } = await pool.query(
        "UPDATE courses SET join_code = $1 WHERE id = $2 RETURNING join_code",
        [newJoinCode(), courseId]
      );
      if (rows.length === 0) throw notFound("Course not found", ERROR_CODES.COURSE_NOT_FOUND);
      return rows[0].join_code;
    } catch (err) {
      if (/** @type {any} */ (err)?.code !== "23505") throw err;
    }
  }
  throw new Error("could not find an unused join code");
};

// Joining by code off. Requests already waiting stay, and can still be decided.
export const clearJoinCode = async (courseId) => {
  const { rowCount } = await pool.query("UPDATE courses SET join_code = NULL WHERE id = $1", [courseId]);
  if (rowCount === 0) throw notFound("Course not found", ERROR_CODES.COURSE_NOT_FOUND);
};

/**
 * A request to join the course this code opens.
 *
 * Answers { course, created, requesterName } — `created` is false when an identical request
 * was already waiting, so the caller does not tell the lecturer twice. A request
 * that was refused, or approved and later removed from the roster, is re-opened
 * rather than duplicated.
 */
export const requestToJoin = async (userId, rawCode) => {
  const code = normaliseJoinCode(rawCode);
  if (!code) throw notFound("No course has this code", ERROR_CODES.JOIN_CODE_NOT_FOUND);

  // An inactive course answers like a wrong code: it is closed to everyone.
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.lecturer_id, u.display_name AS lecturer_name
       FROM courses c LEFT JOIN users u ON u.id = c.lecturer_id
      WHERE c.join_code = $1 AND c.is_active = TRUE`,
    [code]
  );
  const course = rows[0];
  if (!course) throw notFound("No course has this code", ERROR_CODES.JOIN_CODE_NOT_FOUND);
  if (Number(course.lecturer_id) === Number(userId)) {
    throw badRequest("You teach this course", ERROR_CODES.COURSE_IS_YOURS);
  }

  const enrolled = await pool.query(
    "SELECT 1 FROM enrollments WHERE course_id = $1 AND student_id = $2",
    [course.id, userId]
  );
  if (enrolled.rows.length > 0) throw conflict("Already enrolled in this course", ERROR_CODES.ALREADY_ENROLLED);

  // A pending row is left exactly as it is (the WHERE skips the update, and no
  // row comes back); anything else becomes pending again, newly dated.
  const upsert = await pool.query(
    `INSERT INTO course_join_requests (course_id, user_id) VALUES ($1, $2)
     ON CONFLICT (course_id, user_id) DO UPDATE
        SET status = 'pending', created_at = NOW(), decided_at = NULL, decided_by = NULL
      WHERE course_join_requests.status <> 'pending'
     RETURNING id`,
    [course.id, userId]
  );

  const created = upsert.rows.length > 0;
  // Only for a new request: the name the lecturer's notification gives.
  const requester = created
    ? (await pool.query("SELECT display_name, email FROM users WHERE id = $1", [userId])).rows[0] ?? null
    : null;

  return {
    course: { id: course.id, title: course.title, lecturer_id: course.lecturer_id, lecturer_name: course.lecturer_name },
    created,
    requesterName: requester ? requester.display_name || requester.email : null,
  };
};

// The people waiting on this course, oldest first — the order they asked in.
// Their full address, unlike the enrol type-ahead: each of them chose to ask
// THIS lecturer, and an approval needs to know who it is approving.
export const getPendingJoinRequests = async (courseId) => {
  await getCourseById(courseId);
  const { rows } = await pool.query(
    `SELECT r.id, r.user_id, r.created_at, u.display_name, u.email
       FROM course_join_requests r JOIN users u ON u.id = r.user_id
      WHERE r.course_id = $1 AND r.status = 'pending' AND u.is_active = TRUE
      ORDER BY r.created_at`,
    [courseId]
  );
  return rows;
};

/**
 * Approves or refuses one request on this course. Approving enrols in the same
 * transaction, so a request is never "approved" for somebody who is not in the
 * course.
 *
 * The request must be on THIS course — an id from another course's queue is
 * a 404, so the ownership check the controller made on the course covers it.
 * Already decided (another tab, a co-admin) is a 409: the screen is stale.
 *
 * @returns {Promise<{ userId: number, status: "approved" | "rejected" }>}
 */
export const decideJoinRequest = async (courseId, requestId, approve, deciderId) => {
  const status = approve ? "approved" : "rejected";
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE course_join_requests
          SET status = $3, decided_at = NOW(), decided_by = $4
        WHERE id = $1 AND course_id = $2 AND status = 'pending'
        RETURNING user_id`,
      [requestId, courseId, status, deciderId]
    );
    if (rows.length === 0) {
      const exists = await client.query(
        "SELECT 1 FROM course_join_requests WHERE id = $1 AND course_id = $2",
        [requestId, courseId]
      );
      throw exists.rows.length > 0
        ? conflict("This request was already decided", ERROR_CODES.JOIN_REQUEST_DECIDED)
        : notFound("Join request not found");
    }
    const userId = Number(rows[0].user_id);
    if (approve) {
      // ON CONFLICT: enrolled by hand while the request waited — still in.
      await client.query(
        "INSERT INTO enrollments (student_id, course_id) VALUES ($1, $2) ON CONFLICT (student_id, course_id) DO NOTHING",
        [userId, courseId]
      );
    }
    return { userId, status };
  });
};

// The caller's own requests still waiting, for "הקורסים שלי".
export const getMyJoinRequests = async (userId) => {
  const { rows } = await pool.query(
    `SELECT r.id, r.created_at, c.id AS course_id, c.title AS course_title, u.display_name AS lecturer_name
       FROM course_join_requests r
       JOIN courses c ON c.id = r.course_id
       LEFT JOIN users u ON u.id = c.lecturer_id
      WHERE r.user_id = $1 AND r.status = 'pending'
      ORDER BY r.created_at DESC`,
    [userId]
  );
  return rows;
};

// Withdrawing one's own waiting request. Somebody else's id is the same 404 as
// one that does not exist.
export const cancelMyJoinRequest = async (userId, requestId) => {
  const { rowCount } = await pool.query(
    "DELETE FROM course_join_requests WHERE id = $1 AND user_id = $2 AND status = 'pending'",
    [requestId, userId]
  );
  if (rowCount === 0) throw notFound("Join request not found");
  return { cancelled: true, id: Number(requestId) };
};
