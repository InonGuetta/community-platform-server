// @ts-check
import * as servicesBookmarks from "../services/servicesBookmarks.js";
import * as servicesMedia from "../services/servicesMedia.js";
import { canUserSeeMedia } from "../services/servicesVisibility.js";
import {
  requireSeconds, optionalSeconds, optionalId, optionalNote, optionalRect,
} from "../lib/validate.js";
import { badRequest, notFound, ERROR_CODES } from "../lib/AppError.js";

export const getBookmarks = async (req, res) => {
  const mediaId = optionalId(req.query.mediaId, "mediaId");
  const bookmarks = await servicesBookmarks.getBookmarksByUser(req.user.id, mediaId);
  res.status(200).json(bookmarks);
};

// How much of the marked passage is kept on the bookmark.
//
// The quote is a LABEL, not a copy of the book: it is what the side list shows
// and what survives the text being re-extracted underneath the bookmark. A
// thousand characters is several paragraphs — far past anything somebody drags a
// marker across in one gesture, and far short of a chapter.
//
// Capped here rather than by a CHECK on the column, deliberately. The same
// number written in a migration and in this file, with nothing comparing them,
// is exactly the cross-file pair this codebase keeps getting bitten by. One
// authority, and every write goes through it.
export const MAX_QUOTED_TEXT_CHARS = 1000;

// A bookmark anchors EITHER to a moment (audio, video) or to a passage in the
// text (a book) — never to both, and never to neither.
//
// `timestampSeconds` stays required-looking for recordings because that is what
// every existing caller sends; what changed is that supplying `charPosition`
// instead is now a complete request. The either/or is checked here rather than
// by making both optional and hoping, because "neither" produces a row that is
// visible in the list and impossible to jump to.
//
// ── Order of the checks below ───────────────────────────────────────────────
//
// The body is validated FIRST, before the media item is loaded. A malformed
// request then costs no query at all, and — the part that is easy to get wrong —
// a request that is both malformed and points at a hidden item still answers
// 400 for the malformed body rather than 404 for the item. Reversing these two
// turns every input error on an invisible item into a misleading "not found".
export const createBookmark = async (req, res) => {
  const {
    mediaId, timestampSeconds, note, charPosition, charEnd, chunkId, quotedText,
    pageNumber, rect,
  } = req.body ?? {};
  if (mediaId === undefined) throw badRequest("mediaId is required");

  const hasTime = timestampSeconds !== undefined && timestampSeconds !== null;
  const hasPosition = charPosition !== undefined && charPosition !== null;
  // The third kind, from the "מקור" tab: a rectangle on a page of the original
  // file. It needs neither of the other two, and unlike them it does not depend
  // on the extracted text at all — see migration 027.
  const place = optionalRect(rect, "rect");
  if (!hasTime && !hasPosition && place === null) {
    throw badRequest("One of timestampSeconds, charPosition or rect is required");
  }

  if (quotedText !== undefined && quotedText !== null) {
    if (typeof quotedText !== "string") throw badRequest("quotedText must be a string");
    if (quotedText.length > MAX_QUOTED_TEXT_CHARS) {
      throw badRequest(`quotedText must be at most ${MAX_QUOTED_TEXT_CHARS} characters`);
    }
  }

  // Parsed into locals HERE rather than inline in the service call below, and
  // that distinction is the whole reason the order above works. Written as
  // arguments, these guards run when the call is evaluated — after the media
  // lookup — so a malformed offset on an item the caller cannot see answered 404
  // for the item instead of 400 for the offset, and the developer sending the
  // bad value was told the wrong thing.
  const id = optionalId(mediaId, "mediaId");
  const seconds = hasTime ? requireSeconds(timestampSeconds, "timestampSeconds") : null;
  // Reuses the seconds guard: both are non-negative integers a client could
  // send as a string, and both become a confusing 500 at the driver if they
  // reach Postgres as anything else. The name in the error is what differs.
  const position = hasPosition ? requireSeconds(charPosition, "charPosition") : null;
  // Optional, and its absence is meaningful rather than missing: no end means a
  // point anchor — "the paragraph beginning here" — which is what the reader's
  // gutter button has always written and what migration 026 keeps storable on
  // purpose.
  const end = optionalSeconds(charEnd, "charEnd");
  const anchorChunkId = optionalId(chunkId, "chunkId");
  // Reuses the id guard: a page is a positive integer a client could send as a
  // string, exactly like an id, and reaching Postgres as anything else is the
  // same confusing 500.
  const page = optionalId(pageNumber, "pageNumber");

  // Nothing checked that the caller may SEE the item they were marking. A
  // bookmark is not a leak on its own — it stores no content — but it is written
  // against any id the caller cares to name, and the list it comes back in
  // carries the item's title and type. That is enough to enumerate the archive,
  // including drafts and other courses' lessons, through an endpoint nobody
  // thinks of as a read.
  //
  // 404 rather than 403, and the same code the media read answers: an item a
  // student may not see has to be indistinguishable from one that does not
  // exist, or the id space becomes the enumeration it was going to prevent.
  const media = await servicesMedia.getMediaById(id);
  if (!(await canUserSeeMedia(req.user, media))) {
    throw notFound("Media not found", ERROR_CODES.MEDIA_NOT_FOUND);
  }

  const bookmark = await servicesBookmarks.createBookmark({
    userId: req.user.id,
    mediaId: id,
    timestampSeconds: seconds,
    note: optionalNote(note, "note"),
    charPosition: position,
    charEnd: end,
    chunkId: anchorChunkId,
    quotedText: quotedText ?? null,
    pageNumber: page,
    rect: place,
  });
  res.status(201).json(bookmark);
};

// Only the note. A bookmark's anchor is where the reader put it; moving one
// means placing it again, from the text, where the place can be seen.
export const updateBookmark = async (req, res) => {
  const note = optionalNote(req.body?.note, "note");
  const bookmark = await servicesBookmarks.updateBookmark(req.params.id, req.user.id, note);
  res.status(200).json(bookmark);
};

export const deleteBookmark = async (req, res) => {
  const result = await servicesBookmarks.deleteBookmark(req.params.id, req.user.id);
  res.status(200).json(result);
};
