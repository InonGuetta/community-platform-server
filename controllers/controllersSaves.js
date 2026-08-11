// @ts-check
import * as servicesSaves from "../services/servicesSaves.js";
import { optionalId } from "../lib/validate.js";
import { badRequest } from "../lib/AppError.js";
import { isPrivileged } from "../lib/permissions.js";

// ── The general save ────────────────────────────────────────────────────────

// Same split as likes: a screen listing what the user saved wants full media
// rows to render cards, while the save button only needs to know which ids are
// saved. `?ids=1` picks the cheap one rather than making every button pull down
// every saved lecture behind it.
//
// Both are given the SAME visibility, from the same helper the archive uses, so
// the button and the page cannot disagree about whether a draft counts.
export const getSaves = async (req, res) => {
  const includeUnpublished = isPrivileged(req.user);

  if (req.query.ids === "1") {
    const ids = await servicesSaves.getSavedMediaIds(req.user.id, includeUnpublished);
    return res.status(200).json(ids);
  }
  const media = await servicesSaves.getSavedMediaByUser(req.user.id, includeUnpublished);
  res.status(200).json(media);
};

export const createSave = async (req, res) => {
  const mediaId = optionalId(req.body?.mediaId, "mediaId");
  if (!mediaId) throw badRequest("mediaId is required");
  const result = await servicesSaves.addSave(req.user.id, mediaId);
  res.status(201).json(result);
};

export const deleteSave = async (req, res) => {
  const result = await servicesSaves.removeSave(req.user.id, Number(req.params.mediaId));
  res.status(200).json(result);
};

// ── The user's own lists ────────────────────────────────────────────────────

// `?mediaId=` is what the save menu passes: it needs the lists and which of them
// already hold the lecture in front of it, and those are one question.
export const getPlaylists = async (req, res) => {
  const mediaId = optionalId(req.query?.mediaId, "mediaId");
  const playlists = await servicesSaves.getPlaylists(req.user.id, mediaId);
  res.status(200).json(playlists);
};

// One list with its contents, for the page that opens it. Same visibility rule
// as the flat saved list above, from the same helper — a draft is either visible
// to this user in both places or in neither.
export const getPlaylist = async (req, res) => {
  const playlist = await servicesSaves.getPlaylistWithMedia(
    req.user.id,
    Number(req.params.id),
    isPrivileged(req.user)
  );
  res.status(200).json(playlist);
};

// `mediaId` is optional: the save menu sends it so the new list is created with
// the lecture already in it, in one transaction rather than two requests.
export const createPlaylist = async (req, res) => {
  const mediaId = optionalId(req.body?.mediaId, "mediaId");
  const playlist = await servicesSaves.createPlaylist(req.user.id, req.body?.title, mediaId);
  res.status(201).json(playlist);
};

// PATCH rather than PUT: the title is the only editable field, and a caller
// sending just it is describing a change, not replacing the list.
export const updatePlaylist = async (req, res) => {
  const playlist = await servicesSaves.renamePlaylist(
    req.user.id,
    Number(req.params.id),
    req.body?.title
  );
  res.status(200).json(playlist);
};

export const deletePlaylist = async (req, res) => {
  const result = await servicesSaves.deletePlaylist(req.user.id, Number(req.params.id));
  res.status(200).json(result);
};

export const addPlaylistItem = async (req, res) => {
  const mediaId = optionalId(req.body?.mediaId, "mediaId");
  if (!mediaId) throw badRequest("mediaId is required");
  const result = await servicesSaves.addToPlaylist(req.user.id, Number(req.params.id), mediaId);
  res.status(201).json(result);
};

export const deletePlaylistItem = async (req, res) => {
  const result = await servicesSaves.removeFromPlaylist(
    req.user.id,
    Number(req.params.id),
    Number(req.params.mediaId)
  );
  res.status(200).json(result);
};
