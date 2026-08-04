// @ts-check
import * as servicesNotes from "../services/servicesNotes.js";
import { optionalId, optionalSeconds } from "../lib/validate.js";

export const getNotes = async (req, res) => {
  const notes = await servicesNotes.getNotesByUser(req.user.id);
  res.status(200).json(notes);
};

export const createNote = async (req, res) => {
  const { title, body, mediaId, timestampSeconds } = req.body ?? {};
  const note = await servicesNotes.createNote(req.user.id, {
    title,
    body,
    mediaId: optionalId(mediaId, "mediaId"),
    timestampSeconds: optionalSeconds(timestampSeconds, "timestampSeconds"),
  });
  res.status(201).json(note);
};

export const updateNote = async (req, res) => {
  const { title, body } = req.body;
  const note = await servicesNotes.updateNote(req.params.id, req.user.id, { title, body });
  res.status(200).json(note);
};

export const deleteNote = async (req, res) => {
  const result = await servicesNotes.deleteNote(req.params.id, req.user.id);
  res.status(200).json(result);
};
