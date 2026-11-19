// @ts-check
// A profile picture: the signed-in user's own upload and removal, and the
// picture's bytes for whoever is shown it (services/servicesAvatars.js).
// Mounted by routes/routersAuth.js, beside the rest of one's own account.
import fs from "fs";
import * as servicesAvatars from "../services/servicesAvatars.js";
import { requireAvatarImage } from "../lib/validate.js";
import { isLocalKey, localPathOf, openBucketObject, isStorageNotFound } from "../lib/storage.js";
import { getMimeType } from "../lib/mediaFormats.js";
import { streamToResponse } from "../lib/httpStream.js";
import { notFound, ERROR_CODES } from "../lib/AppError.js";

export const uploadAvatar = async (req, res) => {
  const image = requireAvatarImage(req.file);
  const user = await servicesAvatars.setAvatar(req.user.id, image);
  res.status(200).json(user);
};

export const removeAvatar = async (req, res) => {
  const user = await servicesAvatars.removeAvatar(req.user.id);
  res.status(200).json(user);
};

// The picture itself. Its address changes with every new picture (?v=), so the
// browser may keep it for as long as it likes. nosniff: it is only ever drawn
// as an image — and only the three image formats are ever stored.
export const getAvatar = async (req, res) => {
  const key = await servicesAvatars.avatarKeyOf(Number(req.params.id));
  res.set("Cache-Control", "private, max-age=31536000, immutable");
  res.set("X-Content-Type-Options", "nosniff");
  try {
    if (isLocalKey(key)) {
      const path = localPathOf(key);
      // stat first: a missing file must become a 404 before any header is sent.
      const stat = await fs.promises.stat(path);
      res.set("Content-Type", getMimeType(key));
      res.set("Content-Length", String(stat.size));
      return await streamToResponse(fs.createReadStream(path), res, `avatar ${req.params.id}`);
    }
    const object = await openBucketObject(key);
    res.set("Content-Type", getMimeType(key));
    if (object.contentLength) res.set("Content-Length", String(object.contentLength));
    return await streamToResponse(object.stream, res, `avatar ${req.params.id}`);
  } catch (err) {
    if (isStorageNotFound(err)) throw notFound("No picture", ERROR_CODES.NOT_FOUND);
    throw err;
  }
};
