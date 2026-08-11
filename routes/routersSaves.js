// @ts-check
import { Router } from "express";
import { verifyToken } from "../middleware/auth.js";
import { validateIntParam } from "../middleware/validateIntParam.js";
import * as controllersSaves from "../controllers/controllersSaves.js";

const router = Router();

router.use(verifyToken);

// The user's own lists, mounted under the same resource because they are not
// independent of it: a list is a grouping of saved items, and putting a lecture
// in one saves it (see servicesSaves.addToPlaylist).
//
// Declared BEFORE the "/:mediaId" route below. Express matches in order, and
// while /playlists is one segment where that route expects a number — so today
// it would only ever produce a 400 — the ordering is what keeps that true if a
// verb is added to either later.
router.get("/playlists", controllersSaves.getPlaylists);
// One list with its contents — the page that opens a single list, which can be
// reached by URL with nothing else loaded, so the title travels with the rows.
router.get("/playlists/:id", validateIntParam("id"), controllersSaves.getPlaylist);
router.post("/playlists", controllersSaves.createPlaylist);
router.patch("/playlists/:id", validateIntParam("id"), controllersSaves.updatePlaylist);
router.delete("/playlists/:id", validateIntParam("id"), controllersSaves.deletePlaylist);

router.post("/playlists/:id/items", validateIntParam("id"), controllersSaves.addPlaylistItem);
router.delete(
  "/playlists/:id/items/:mediaId",
  validateIntParam("id"),
  validateIntParam("mediaId"),
  controllersSaves.deletePlaylistItem
);

// The general save. Keyed by mediaId on the way out, like likes: the client
// knows which lecture it is looking at and would otherwise have to find the save
// row first just to remove it.
router.get("/", controllersSaves.getSaves);
router.post("/", controllersSaves.createSave);
router.delete("/:mediaId", validateIntParam("mediaId"), controllersSaves.deleteSave);

export default router;
