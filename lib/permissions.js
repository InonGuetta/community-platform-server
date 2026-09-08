// @ts-check
import { forbidden } from "./AppError.js";

// Who may see unpublished material and manage the library.
//
// Kept here rather than beside one controller because media AND transcripts
// have to agree on it: a transcript inherits the visibility of its media item,
// so a second copy of this rule drifting out of sync is precisely how a draft
// leaks through the search or the transcript endpoint.
export const isPrivileged = (user) => user?.role === "lecturer" || user?.role === "admin";

// ── Whether a given media item may be seen ──────────────────────────────────
//
// The rule itself is one line and has always been one line. What it did not have
// was one HOME: the same comparison was written out at ten query sites — four
// media handlers, the transcript read, three search modes, both likes reads and
// three saves reads — each phrased slightly differently. `(m.is_published OR
// $2)` in one file, `($2 OR m.is_published = TRUE)` in another, and a JavaScript
// `!item.is_published && !isPrivileged(user)` in a third.
//
// Ten copies of a rule that never changes are survivable. The reason to collect
// them now is that the rule is about to stop never changing: restricting a
// student to the courses they are enrolled in adds a second condition to every
// one of these sites, and adding a condition to ten hand-written copies is
// exactly how one gets missed. The one that gets missed is not a broken page —
// it is a draft, or somebody else's course, quietly listed.
//
// ── What "visible courses" means, and why it is one value ───────────────────
//
// Every read below is parameterised by a single value describing what this
// caller may see:
//
//   null        — no restriction. A lecturer or an admin, who sees drafts and
//                 every course.
//   number[]    — a student, and the courses they are enrolled in. Possibly
//                 empty, which is a real answer and not a missing one.
//
// One value rather than a flag plus a list, and that is what kept this change
// small: the SQL builder's signature did not move, so the nine call sites that
// pass `$2` still pass `$2`. Only what they put in it changed.
//
// Failing closed is the default everywhere. A caller that passes nothing gets
// `[]` — enrolled in nothing — rather than the unrestricted view.
export const UNRESTRICTED = null;

// A lesson attached to no course is the GENERAL LIBRARY, and stays visible to
// everyone. That is not a concession: it is what every item uploaded before
// courses existed is, so the alternative would have hidden the entire existing
// archive from every student on the day this shipped.
// ── Two dimensions, not one ─────────────────────────────────────────────────
//
// `visibleCourses` answers "which PUBLISHED lessons may this caller see", and
// `visibleDrafts` answers "whose UNPUBLISHED ones". They are separate questions
// and were collapsed into one for as long as a lecturer simply saw everything:
//
//   admin     courses = null   drafts = null    everything
//   lecturer  courses = null   drafts = [id]    every published lesson, and
//                                               their OWN drafts only
//   student   courses = [...]  drafts = []      published, in their courses
//
// Both follow the SAME convention — null means unrestricted, an array means
// exactly these — which is what let this become one extra parameter rather than
// a flag plus a list. An EMPTY array is a real answer ("nobody's drafts"), which
// is why `[]` and `null` must never be conflated; `?? []` on a null would hand a
// lecturer nothing and an admin nothing, silently.
//
// Failing closed stays the default: a caller that passes neither gets published
// lessons in no courses and nobody's drafts.
export const canSeeMediaRow = (item, visibleCourses = [], visibleDrafts = []) => {
  // Whose drafts — checked first, because it is the branch that admits an
  // unpublished row and the only one that can.
  const owner = Number(item?.uploader_id);
  const draftsUnrestricted = visibleDrafts === UNRESTRICTED;
  const ownsIt =
    Array.isArray(visibleDrafts) &&
    Number.isInteger(owner) &&
    visibleDrafts.map(Number).includes(owner);
  if (draftsUnrestricted || ownsIt) return true;

  // Which published lessons.
  if (!item?.is_published) return false;
  if (visibleCourses === UNRESTRICTED) return true;
  const courseId = item.course_id;
  if (courseId === null || courseId === undefined) return true;
  return Array.isArray(visibleCourses) && visibleCourses.map(Number).includes(Number(courseId));
};

// The same rule as SQL, for the reads that filter in the database rather than
// checking a row already in hand.
//
// Takes the placeholder rather than building the parameter list, because the
// callers number their parameters differently and threading that through here
// would be more coupling than the duplication is worth.
//
// The NULL test is what carries "unrestricted", and it is why each dimension
// needs exactly one placeholder: pg sends a JavaScript null as SQL NULL and an
// array as an array, so one parameter expresses both cases. The ::int[] casts
// are load-bearing — pg sends parameters untyped, and neither `IS NULL` nor
// `= ANY(...)` resolves against an untyped parameter.
//
// `visibleDraftsParam` defaults to the literal NULL, which reads as "every
// draft". That default exists for exactly one caller — a query that has already
// established the caller may see everything — and any read reachable by a
// student must pass it explicitly. It is the one place in this file that does
// NOT fail closed, and it is spelled out here rather than hidden so that a new
// call site copying an old one is a decision rather than an accident.
export const visibleMediaSql = (visibleCoursesParam, alias = "m", visibleDraftsParam = "NULL") => `(
    (
      ${alias}.is_published
      AND (
        ${visibleCoursesParam}::int[] IS NULL
        OR ${alias}.course_id IS NULL
        OR ${alias}.course_id = ANY(${visibleCoursesParam}::int[])
      )
    )
    OR (
      ${visibleDraftsParam}::int[] IS NULL
      OR ${alias}.uploader_id = ANY(${visibleDraftsParam}::int[])
    )
  )`;

// Who may CHANGE a given item, as opposed to who may see drafts.
//
// requireRole on the route establishes that the caller is a lecturer or an
// admin. It cannot establish *which* items they may touch, because it runs
// before the item is loaded — which is why every write path has to ask this
// second question after the fetch. An admin manages the whole library; a
// lecturer manages only what they uploaded.
//
// Read paths deliberately do NOT use this: a published item is readable by
// everyone, and isPrivileged above is what governs drafts. This governs writes —
// update (which carries is_published), delete, and every transcript mutation,
// since a transcript is an edit to somebody's media item.
//
// Both ids are integers out of pg, but they are compared numerically rather than
// with === because an id that has been through a route param or JSON round-trip
// arrives as a string, and a silent false there would hand a lecturer someone
// else's item on the admin path and lock them out of their own on the lecturer
// path. servicesUsers was bitten by exactly this.
export const canManageMedia = (user, item) => {
  if (user?.role === "admin") return true;
  if (user?.role !== "lecturer") return false;
  const owner = Number(item?.uploader_id);
  const caller = Number(user?.id);
  return Number.isInteger(owner) && Number.isInteger(caller) && owner === caller;
};

// The throwing form, so the six write paths that enforce this share one status
// and one message instead of six copies that can drift.
//
// 403, not 404: the caller already got past requireRole and the item is one they
// can legitimately see, so hiding its existence buys nothing and turns "not
// yours" into a confusing "gone". The 404-instead-of-403 treatment belongs on the
// read paths, where it hides unpublished drafts from students.
export const assertCanManageMedia = (user, item) => {
  if (!canManageMedia(user, item)) {
    throw forbidden("You may only manage media you uploaded");
  }
};
