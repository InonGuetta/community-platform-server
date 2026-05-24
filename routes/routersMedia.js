import { Router } from "express";
import multer from "multer";
import { verifyToken } from "../middleware/auth.js";
import * as controllersMedia from "../controllers/controllersMedia.js";

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

router.get("/get-all", controllersMedia.getAllMedia);
router.get("/:id", controllersMedia.getMediaById);
router.post("/upload", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      console.error("[upload] multer error:", err.message);
      return res.status(400).json({ message: err.message });
    }
    console.log("[upload] file:", req.file ? `${req.file.originalname} (${req.file.mimetype}, ${req.file.size}B)` : "MISSING");
    console.log("[upload] body:", req.body);
    next();
  });
}, controllersMedia.createMedia);
router.put("/update/:id", controllersMedia.updateMedia);
router.delete("/delete/:id", controllersMedia.deleteMedia);
router.get("/:id/stream", controllersMedia.streamMedia);
router.get("/:id/download", controllersMedia.downloadMedia);
router.get("/:id/progress", controllersMedia.getProgress);
router.post("/:id/progress", controllersMedia.saveProgress);

export default router;
