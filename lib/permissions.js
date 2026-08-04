// @ts-check
import { forbidden } from "./AppError.js";

// Who may see unpublished material and manage the library.
//
// Kept here rather than beside one controller because media AND transcripts
// have to agree on it: a transcript inherits the visibility of its media item,
// so a second copy of this rule drifting out of sync is precisely how a draft
// leaks through the search or the transcript endpoint.
export const isPrivileged = (user) => user?.role === "lecturer" || user?.role === "admin";

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
