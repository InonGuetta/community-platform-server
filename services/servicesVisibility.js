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
import { canSeeMediaRow, UNRESTRICTED } from "../lib/permissions.js";
import { getEnrolledCourseIds } from "./servicesCourses.js";

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
  if (user?.role === "admin") return { courses: UNRESTRICTED, drafts: UNRESTRICTED };
  if (user?.role === "lecturer") return { courses: UNRESTRICTED, drafts: [user.id] };
  return { courses: await getEnrolledCourseIds(user.id), drafts: [] };
};

// The courses half, for the handful of callers that only need that one.
export const visibleCoursesFor = async (user) => (await viewerScopeFor(user)).courses;

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
  if (user?.role === "admin") return true;
  if (user?.role === "lecturer" && Number(item?.uploader_id) === Number(user.id)) return true;

  // Past that, only published material, and the general library is settled
  // without the enrolment lookup — which is most of the archive.
  if (!item?.is_published) return false;
  if (user?.role === "lecturer") return true; // every published lesson, any course
  if (item.course_id === null || item.course_id === undefined) return true;
  return canSeeMediaRow(item, await getEnrolledCourseIds(user.id), []);
};
