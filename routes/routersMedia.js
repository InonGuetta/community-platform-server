import fs from "fs";
import { Router } from "express";
import multer from "multer";
import { verifyToken } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { validateIntParam } from "../middleware/validateIntParam.js";
import * as controllersMedia from "../controllers/controllersMedia.js";
import { LOCAL_UPLOAD_DIR } from "../lib/storage.js";
import { MEDIA_TYPE_BY_EXT, extensionOf } from "../lib/mediaFormats.js";
import { logger } from "../lib/logger.js";

const router = Router();

// Default matches the previous hard-coded value so nothing that uploads today
// starts failing. Now that the destination is disk rather than the heap, the
// real constraint is free space — lower this once you know what the box has.
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 2 * 1024 * 1024 * 1024;

// The stored filename is generated, never taken from the client, so an
// originalname of "../../etc/passwd" cannot escape the directory.
const generatedFilename = (originalname) => {
  const ext = extensionOf(originalname);
  return `${Date.now()}-${Math.random().toString(36).slice(2)}${ext ? `.${ext}` : ""}`;
};

// diskStorage, not memoryStorage: the previous config buffered the entire body
// in the Node heap, so two concurrent 1GB uploads could exhaust it. Writing
// straight into LOCAL_UPLOAD_DIR (rather than a temp dir) also sidesteps EXDEV
// — on Windows the temp dir is often on a different volume and fs.rename across
// volumes fails.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.promises
        .mkdir(LOCAL_UPLOAD_DIR, { recursive: true })
        .then(() => cb(null, LOCAL_UPLOAD_DIR))
        .catch(cb);
    },
    filename: (req, file, cb) => cb(null, generatedFilename(file.originalname)),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  // Filter on the EXTENSION, not the client-declared mimetype: the extension is
  // what getMimeType uses to pick the Content-Type on the way back out, so it is
  // the field that actually has to be trustworthy. The mediaType cross-check
  // happens in the controller, where the parsed body is available — here the
  // file part can arrive before the text fields.
  fileFilter: (req, file, cb) => {
    const ext = extensionOf(file.originalname);
    if (!MEDIA_TYPE_BY_EXT[ext]) {
      return cb(new Error("Only video, audio, and text files are allowed"));
    }
    cb(null, true);
  },
});

router.use(verifyToken);

// Only lecturers/admins manage the library. The controller still enforces
// is_published visibility on reads (students never see unpublished items).
const canManage = requireRole("lecturer", "admin");

router.get("/get-all", controllersMedia.getAllMedia);
router.get("/:id", validateIntParam("id"), controllersMedia.getMediaById);
// multer reports a rejected file (wrong type, over the size limit) through its
// own callback rather than as an AppError, so it needs this wrapper to become a
// 400 instead of falling through to the generic 500 handler.
router.post("/upload", canManage, (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      logger.warn(`[upload] rejected: ${err.message}`);
      return res.status(400).json({ message: err.message });
    }
    next();
  });
}, controllersMedia.createMedia);
router.put("/update/:id", canManage, validateIntParam("id"), controllersMedia.updateMedia);
router.delete("/delete/:id", canManage, validateIntParam("id"), controllersMedia.deleteMedia);
router.get("/:id/stream", validateIntParam("id"), controllersMedia.streamMedia);
router.get("/:id/download", validateIntParam("id"), controllersMedia.downloadMedia);
router.get("/:id/download/audio", validateIntParam("id"), controllersMedia.downloadMediaAudio);
router.get("/:id/progress", validateIntParam("id"), controllersMedia.getProgress);
router.post("/:id/progress", validateIntParam("id"), controllersMedia.saveProgress);

export default router;
