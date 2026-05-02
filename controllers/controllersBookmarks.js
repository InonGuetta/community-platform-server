import * as servicesBookmarks from "../services/servicesBookmarks.js";

export const getBookmarks = async (req, res) => {
  try {
    const { mediaId } = req.query;
    const bookmarks = await servicesBookmarks.getBookmarksByUser(req.user.id, mediaId);
    res.status(200).json(bookmarks);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const createBookmark = async (req, res) => {
  try {
    const { mediaId, timestampSeconds, note } = req.body;
    if (!mediaId || timestampSeconds === undefined) return res.status(400).json({ message: "mediaId and timestampSeconds are required" });
    const bookmark = await servicesBookmarks.createBookmark(req.user.id, mediaId, timestampSeconds, note);
    res.status(201).json(bookmark);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

export const updateBookmark = async (req, res) => {
  try {
    const { note } = req.body;
    const bookmark = await servicesBookmarks.updateBookmark(req.params.id, req.user.id, note);
    res.status(200).json(bookmark);
  } catch (err) {
    res.status(404).json({ message: err.message });
  }
};

export const deleteBookmark = async (req, res) => {
  try {
    const result = await servicesBookmarks.deleteBookmark(req.params.id, req.user.id);
    res.status(200).json(result);
  } catch (err) {
    res.status(404).json({ message: err.message });
  }
};
