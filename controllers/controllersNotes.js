// @ts-check
import * as servicesNotes from "../services/servicesNotes.js";
import { assertUserCanSeeMediaId, viewerScopeFor } from "../services/servicesVisibility.js";
import { optionalId, optionalSeconds, requireIdList, optionalQueryString } from "../lib/validate.js";
import { badRequest } from "../lib/AppError.js";

// One route, three answers (PRD NOTE-17) — see servicesNotes:
//   GET /notes                  the list, light: a preview and no body
//   GET /notes?q=…              the same list, searched over the whole text
//   GET /notes?ids=1,2,3        those notes whole (the cards on screen, an export)
//   GET /notes?aboutMediaId=7   one lesson's notes whole (the lesson page)
// Asking for two at once is a 400: each answers a different question, and
// silently preferring one would hide the mistake.
export const getNotes = async (req, res) => {
  const { q, ids, aboutMediaId } = req.query;
  const modes = [ids !== undefined, aboutMediaId !== undefined, q !== undefined].filter(Boolean).length;
  if (modes > 1) throw badRequest("Ask for one of ids, aboutMediaId or q");

  const scope = await viewerScopeFor(req.user);
  let notes;
  if (ids !== undefined) {
    notes = await servicesNotes.getNotesWithBodies(req.user.id, scope, requireIdList(String(ids).split(","), "ids"));
  } else if (aboutMediaId !== undefined) {
    notes = await servicesNotes.getNotesAboutMedia(req.user.id, scope, optionalId(aboutMediaId, "aboutMediaId"));
  } else {
    notes = await servicesNotes.getNotesByUser(req.user.id, scope, { search: optionalQueryString(q, "q") });
  }
  res.status(200).json(notes.map(withoutBodyText));
};

// body_text (migration 038) is for the server's own preview and search. A whole
// note already carries its body; sending the same words twice would only make
// the response bigger.
const withoutBodyText = ({ body_text, ...note }) => note;

// A note may be attached to a lecture, and getNotesByUser joins that lecture back
// in to show its title. Nothing checked that the caller was entitled to the
// lecture, so pointing a note at an unpublished draft's id and reading the note
// list back returned that draft's title — the one place in the application where
// the is_published gate was not applied.
//
// The same 404 the media and transcript endpoints answer, for the same reason:
// an id that exists but is hidden must be indistinguishable from one that does
// not, or the endpoint becomes a way to enumerate what is in the library.
export const createNote = async (req, res) => {
  const { title, body, mediaId, timestampSeconds } = req.body ?? {};
  const linkedMediaId = optionalId(mediaId, "mediaId");
  if (linkedMediaId !== null) await assertUserCanSeeMediaId(req.user, linkedMediaId);
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
