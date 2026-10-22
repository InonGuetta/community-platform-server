// @ts-check
// Whether the caller may discuss this lesson at all.
//
// Every door in the discussion service — the search, the conversation, and the
// chat that will answer from the lesson's text — asks this first, before any
// chunk is read, any message is returned or any OpenAI call is made. One copy,
// because the alternative is three, and the one that drifts is the one that
// hands a student the text of a course they are not in.
//
// The rule itself is lib/permissions.js's, the same one every read of a lesson
// uses. 404 rather than 403, as on every read path, so that the id space is not
// a catalogue of what each course holds.
import { pool } from "../../db/pool.js";
import { canSeeMediaRow } from "../../lib/permissions.js";
import { notFound, ERROR_CODES } from "../../lib/AppError.js";

/**
 * @param {number|string} mediaId
 * @param {{ courses: number[]|null, drafts: number[]|null }} scope  from viewerScopeFor
 */
export const assertCanSeeLesson = async (mediaId, scope) => {
  const media = await pool.query(
    "SELECT is_published, course_id, uploader_id FROM media_items WHERE id=$1",
    [mediaId]
  );
  if (media.rows.length === 0 || !canSeeMediaRow(media.rows[0], scope.courses, scope.drafts)) {
    throw notFound("Media not found", ERROR_CODES.MEDIA_NOT_FOUND);
  }
};
