// @ts-check
import * as servicesNotes from "../services/servicesNotes.js";
import * as servicesMedia from "../services/servicesMedia.js";
import { canUserSeeMedia } from "../services/servicesVisibility.js";
import { optionalId, optionalSeconds, requireIdList } from "../lib/validate.js";
import { notFound, ERROR_CODES } from "../lib/AppError.js";

export const getNotes = async (req, res) => {
  const notes = await servicesNotes.getNotesByUser(req.user.id);
  res.status(200).json(notes);
};

// A note may be attached to a lecture, and getNotesByUser joins that lecture back
// in to show its title. Nothing checked that the caller was entitled to the
// lecture, so pointing a note at an unpublished draft's id and reading the note
// list back returned that draft's title — the one place in the application where
// the is_published gate was not applied.
//
// The same 404 the media and transcript endpoints answer, for the same reason:
// an id that exists but is hidden must be indistinguishable from one that does
// not, or the endpoint becomes a way to enumerate what is in the library.
const assertMediaVisible = async (user, mediaId) => {
  if (mediaId === null) return;
  const item = await servicesMedia.getMediaById(mediaId);
  if (!(await canUserSeeMedia(user, item))) {
    throw notFound("Media not found", ERROR_CODES.MEDIA_NOT_FOUND);
  }
};

export const createNote = async (req, res) => {
  const { title, body, mediaId, timestampSeconds } = req.body ?? {};
  const linkedMediaId = optionalId(mediaId, "mediaId");
  await assertMediaVisible(req.user, linkedMediaId);
  const note = await servicesNotes.createNote(req.user.id, {
    title,
    body,
    mediaId: linkedMediaId,
    timestampSeconds: optionalSeconds(timestampSeconds, "timestampSeconds"),
  });
  res.status(201).json(note);
};

export const updateNote = async (req, res) => {
  const { title, body } = req.body;
  const note = await servicesNotes.updateNote(req.params.id, req.user.id, { title, body });
  res.status(200).json(note);
};

// The notebook's order, rewritten wholesale: `ids` is the notebook as the user
// has just arranged it, front to back.
//
// The whole list rather than "move note 4 to position 2" because the client
// already knows the answer — it is rendering it — and a positional instruction
// has to be interpreted against a server-side order that may have moved on. A
// list is idempotent: sending it twice leaves the same notebook.
//
// Ids the caller does not own are dropped by the service rather than refused,
// so a stale tab that names a note deleted on another device still reorders the
// notes that are left instead of failing whole.
export const reorderNotes = async (req, res) => {
  const ids = requireIdList(req.body?.ids, "ids");
  const result = await servicesNotes.reorderNotes(req.user.id, ids);
  res.status(200).json(result);
};

export const deleteNote = async (req, res) => {
  const result = await servicesNotes.deleteNote(req.params.id, req.user.id);
  res.status(200).json(result);
};
