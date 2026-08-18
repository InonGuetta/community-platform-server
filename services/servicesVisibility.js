// @ts-check
// Turning a signed-in user into the value every media read is filtered by.
//
// lib/permissions.js owns the RULE and stays pure — it can be reasoned about and
// tested without a database. This owns the one thing the rule cannot answer for
// itself: which courses this particular person is enrolled in. That needs a
// query, so it belongs in a service, and it belongs in exactly one service or the
// six handlers that need it would each grow their own copy.
//
// The name is not a resource, unlike servicesMedia or servicesCourses. Neither is
// servicesHealth. What both have in common is that they answer a question the
// application asks rather than manage a thing it stores.
import { isPrivileged, canSeeMediaRow, UNRESTRICTED } from "../lib/permissions.js";
import { getEnrolledCourseIds } from "./servicesCourses.js";

// What this user may see, in the form every query takes: null for someone who
// may see everything, otherwise the courses they are enrolled in.
//
// One query per request for a student, none for a lecturer or an admin.
export const visibleCoursesFor = async (user) => {
  if (isPrivileged(user)) return UNRESTRICTED;
  return getEnrolledCourseIds(user.id);
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
  if (isPrivileged(user)) return true;
  if (!item?.is_published) return false;
  if (item.course_id === null || item.course_id === undefined) return true;
  return canSeeMediaRow(item, await getEnrolledCourseIds(user.id));
};
