// @ts-check
import * as servicesLikes from "../services/servicesLikes.js";
import { optionalId } from "../lib/validate.js";
import { badRequest } from "../lib/AppError.js";
import { visibleCoursesFor } from "../services/servicesVisibility.js";

// The likes page wants full media rows to render cards; the media page and the
// archive only want to know which ids are liked, so they can light up a button
// without pulling every liked lecture down with it. `?ids=1` picks the cheap one.
//
// Both are given the SAME visibility, from the same helper the archive uses, so
// the button and the page cannot disagree about whether a draft counts.
export const getLikes = async (req, res) => {
  const visibleCourses = await visibleCoursesFor(req.user);

  if (req.query.ids === "1") {
    const ids = await servicesLikes.getLikedMediaIds(req.user.id, visibleCourses);
    return res.status(200).json(ids);
  }
  const media = await servicesLikes.getLikedMediaByUser(req.user.id, visibleCourses);
  res.status(200).json(media);
};

export const createLike = async (req, res) => {
  const mediaId = optionalId(req.body?.mediaId, "mediaId");
  if (!mediaId) throw badRequest("mediaId is required");
  const result = await servicesLikes.addLike(req.user.id, mediaId);
  res.status(201).json(result);
};

export const deleteLike = async (req, res) => {
  const result = await servicesLikes.removeLike(req.user.id, Number(req.params.mediaId));
  res.status(200).json(result);
};
