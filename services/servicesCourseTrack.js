// @ts-check
// A course as a track (PRD CRS-1, CRS-2, CRS-3, migration 043): its lessons in
// the order the lecturer chose, each with how far THIS reader got, and what
// comes next.
//
// Progress is not a new measurement. The player has saved a position per
// person per lesson since it was written (watch_progress); what this adds is
// the moment a lesson counts as heard — `completed_at`, set the first time the
// position reaches COMPLETE_SHARE of its length (servicesMedia →
// saveWatchProgress) — and reading it across a course instead of one lesson.
import { pool } from "../db/pool.js";
import { visibleMediaSql } from "../lib/permissions.js";
import { badRequest } from "../lib/AppError.js";

// Nine tenths: the closing words of a shiur, the questions after it and the
// last save the player did not get to make before the tab closed do not stand
// between a listener and a lesson they heard.
export const COMPLETE_SHARE = 0.9;

// The lessons of one course, in track order, as this caller may see them.
// Arranged lessons first by their place; the rest after them, oldest first —
// a lesson added since the lecturer last arranged the course joins the end.
export const getCourseLessons = async (courseId, userId, scope) => {
  const { rows } = await pool.query(
    `SELECT m.id, m.title, m.media_type, m.duration_seconds, m.creator_name, m.thumbnail_url,
            m.is_published, m.course_position, m.created_at,
            wp.last_position_seconds, wp.completed_at
       FROM media_items m
       LEFT JOIN watch_progress wp ON wp.media_id = m.id AND wp.user_id = $2
      WHERE m.course_id = $1 AND ${visibleMediaSql("$3", "m", "$4")}
      ORDER BY m.course_position NULLS LAST, m.created_at, m.id`,
    [courseId, userId, scope.courses, scope.drafts]
  );
  return rows;
};

// What a book is: something to read, with no position to have reached the end
// of. Listed in the track, not counted in its progress.
const counts = (lesson) => lesson.media_type !== "text";

/**
 * The reader's place in the track.
 *
 * `next` is where to carry on: the first recording not yet finished, in order —
 * one already started before one not yet begun only if it comes first, because
 * a track is followed in its order, not by recency. Null when every recording
 * is finished.
 */
export const trackSummary = (lessons) => {
  const counted = lessons.filter(counts);
  const completed = counted.filter((l) => l.completed_at).length;
  const next = counted.find((l) => !l.completed_at) ?? null;
  return { total: counted.length, completed, nextId: next?.id ?? null };
};

/**
 * Puts a course's lessons in this order. The list must name every lesson in the
 * course — exactly those, each once — so an order is never half-applied and a
 * lesson cannot be moved in from another course by naming it.
 *
 * Drafts included: arranging is the lecturer's, and a draft has a place in the
 * track before it is published.
 */
export const reorderCourseLessons = async (courseId, mediaIds) => {
  const { rows } = await pool.query("SELECT id FROM media_items WHERE course_id = $1", [courseId]);
  const inCourse = new Set(rows.map((r) => Number(r.id)));
  if (mediaIds.length !== inCourse.size || !mediaIds.every((id) => inCourse.has(id))) {
    throw badRequest("The order must list every lesson in this course, once");
  }
  await pool.query(
    `UPDATE media_items m
        SET course_position = o.pos
       FROM unnest($2::int[]) WITH ORDINALITY AS o(id, pos)
      WHERE m.id = o.id AND m.course_id = $1`,
    [courseId, mediaIds]
  );
  return { courseId: Number(courseId), order: mediaIds };
};
