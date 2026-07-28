import { Router } from "express";
import multer from "multer";
import { verifyToken } from "../middleware/auth.js";
import { requireRole } from "../middleware/requireRole.js";
import { validateIntParam } from "../middleware/validateIntParam.js";
import * as controllersMedia from "../controllers/controllersMedia.js";
import { logger } from "../lib/logger.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
  fileFilter: (req, file, cb) => {
    const isVideo = file.mimetype.startsWith("video/");
    const isAudio = file.mimetype.startsWith("audio/");
    const isText = file.mimetype.startsWith("text/") ||
      file.mimetype === "application/pdf" ||
      file.mimetype === "application/msword" ||
      file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (!isVideo && !isAudio && !isText) {
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
router.get("/:id/progress", validateIntParam("id"), controllersMedia.getProgress);
router.post("/:id/progress", validateIntParam("id"), controllersMedia.saveProgress);

export default router;
