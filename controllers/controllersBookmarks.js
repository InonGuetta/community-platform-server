import * as servicesBookmarks from "../services/servicesBookmarks.js";
import { badRequest } from "../lib/AppError.js";

export const getBookmarks = async (req, res) => {
  const { mediaId } = req.query;
  const bookmarks = await servicesBookmarks.getBookmarksByUser(req.user.id, mediaId);
  res.status(200).json(bookmarks);
};

export const createBookmark = async (req, res) => {
  const { mediaId, timestampSeconds, note } = req.body;
  if (!mediaId || timestampSeconds === undefined) throw badRequest("mediaId and timestampSeconds are required");
  const bookmark = await servicesBookmarks.createBookmark(req.user.id, mediaId, timestampSeconds, note);
  res.status(201).json(bookmark);
};

export const updateBookmark = async (req, res) => {
  const { note } = req.body;
  const bookmark = await servicesBookmarks.updateBookmark(req.params.id, req.user.id, note);
  res.status(200).json(bookmark);
};

export const deleteBookmark = async (req, res) => {
  const result = await servicesBookmarks.deleteBookmark(req.params.id, req.user.id);
  res.status(200).json(result);
};
