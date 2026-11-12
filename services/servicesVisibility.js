// @ts-check
// Turning a signed-in user into the value every media read is filtered by.
//
// lib/permissions.js owns the RULE and stays pure — it can be reasoned about and
// tested without a database. This owns the one thing the rule cannot answer for
// itself: which courses this particular person is enrolled in. That needs a
// query, so it belongs in a service, and it belongs in exactly one service or the
// six handlers that need it would each grow their own copy.
//
// It is also the guard every door that takes a lesson's id asks — "may this
// caller see this item?" — and the 404 it answers when not (below). One copy,
// because each door that wrote its own check worded the refusal its own way.
//
// The name is not a resource, unlike servicesMedia or servicesCourses. Neither is
// servicesHealth. What both have in common is that they answer a question the
// application asks rather than manage a thing it stores.
import { pool } from "../db/pool.js";
import { canSeeMediaRow, UNRESTRICTED, isAdmin, isLecturer } from "../lib/permissions.js";
import { getEnrolledCourseIds } from "./servicesCourses.js";
import { getMediaById } from "./servicesMedia.js";
import { notFound, ERROR_CODES } from "../lib/AppError.js";

// What this user may see, in the two forms every media query takes.
//
//   admin     { courses: null,  drafts: null  }   everything
//   lecturer  { courses: null,  drafts: [id]  }   every published lesson, and
//                                                 their OWN drafts only
//   student   { courses: [...], drafts: []    }   published, in their courses
//
// A lecturer used to get UNRESTRICTED on the single dimension that existed,
// which meant every draft on the platform — including a colleague's unpublished
// work in progress. The two dimensions separate "which published lessons" from
// "whose drafts", so a lecturer keeps the whole published archive and loses only
// what was never theirs to see.
//
// Still one query per request for a student and none for anybody else.
export const viewerScopeFor = async (user) => {
  if (isAdmin(user)) return { courses: UNRESTRICTED, drafts: UNRESTRICTED };
  if (isLecturer(user)) return { courses: UNRESTRICTED, drafts: [user.id] };
  return { courses: await getEnrolledCourseIds(user.id), drafts: [] };
};

// Whether one already-loaded item may be seen, without paying for the enrolment
// lookup unless the answer actually depends on it.
//
// The ordering here is the whole optimisation, and it matters because of what the
// library looks like today: `course_id` is null on every item uploaded before
// courses existed, which is most of the archive. Those are settled by the checks
// above the query, so opening a lecture costs no extra round trip — only a lesson
// that genuinely belongs to a course does.
export const canUserSeeMedia = async (user, item) => {
  // An admin sees everything, and a lecturer sees anything they uploaded —
  // both settled without touching the database.
  if (isAdmin(user)) return true;
  if (isLecturer(user) && Number(item?.uploader_id) === Number(user.id)) return true;

  // Past that, only published material, and the general library is settled
  // without the enrolment lookup — which is most of the archive.
  if (!item?.is_published) return false;
  if (isLecturer(user)) return true; // every published lesson, any course
  if (item.course_id === null || item.course_id === undefined) return true;
  return canSeeMediaRow(item, await getEnrolledCourseIds(user.id), []);
};

// ── The guard: every door that takes a lesson's id ──────────────────────────
//
// What a lesson the caller may not see answers: 404, and the very error a lesson
// that does not exist answers (servicesMedia.getMediaById throws the same). Not
// 403 — an item a student may not see must be indistinguishable from one that
// does not exist, or the id space becomes a way to enumerate drafts and other
// courses' lessons.
export const hiddenMediaError = () => notFound("Media not found", ERROR_CODES.MEDIA_NOT_FOUND);

// An item already loaded — the read, the stream, the download, the progress.
// Returns the item, so a call site can load and check in one line.
export const assertUserCanSeeMedia = async (user, item) => {
  if (!(await canUserSeeMedia(user, item))) throw hiddenMediaError();
  return item;
};

// By id: "this caller is about to read, or attach something of theirs to, this
// item — may they see it?"
//
// Likes, saves and playlist items wrote against any id the caller named. That
// let a student like a draft (counted in like_count, which its owner sees) and
// turned the FK error on a missing id — a 500, against a 201 for one that
// exists — into a way to enumerate the archive. Notes and bookmarks the same:
// the list they come back in carries the item's title.
export const assertUserCanSeeMediaId = async (user, mediaId) =>
  assertUserCanSeeMedia(user, await getMediaById(mediaId));

// By id, for a caller whose scope viewerScopeFor has already resolved — the
// transcript and every door of the discussion, which hold the scope for their
// own reads anyway. A transcript has no visibility of its own: it inherits the
// item's, so the two answering differently is the definition of a leak.
//
// uploader_id rides along because the rule has two dimensions: whose DRAFTS a
// caller may see is answered by who uploaded the item, and a SELECT that omits
// it silently made every lecturer fail the ownership half.
/**
 * @param {number|string} mediaId
 * @param {{ courses: number[]|null, drafts: number[]|null }} scope  from viewerScopeFor
 */
export const canScopeSeeMediaId = async (mediaId, scope) => {
  const media = await pool.query(
    "SELECT is_published, course_id, uploader_id FROM media_items WHERE id=$1",
    [mediaId]
  );
  return media.rows.length > 0 && canSeeMediaRow(media.rows[0], scope.courses, scope.drafts);
};

/**
 * @param {number|string} mediaId
 * @param {{ courses: number[]|null, drafts: number[]|null }} scope  from viewerScopeFor
 */
export const assertScopeCanSeeMediaId = async (mediaId, scope) => {
  if (!(await canScopeSeeMediaId(mediaId, scope))) throw hiddenMediaError();
};
