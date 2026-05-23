import * as servicesMedia from "../services/servicesMedia.js";
import { S3Client, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import mammoth from "mammoth";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_UPLOAD_DIR = path.join(__dirname, "../uploads");

const s3Configured = () => !!(
  process.env.AWS_REGION &&
  process.env.S3_BUCKET &&
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY
);
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

const MIME_TYPES = {
  pdf: "application/pdf",
  txt: "text/plain",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
};
const getMimeType = (filename) => {
  const ext = filename.split(".").pop().toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
};

export const getAllMedia = async (req, res) => {
  try {
    const { type, published, search } = req.query;
    const items = await servicesMedia.getAllMedia({
      type,
      published: published !== undefined ? published === "true" : undefined,
      search,
    });
    res.status(200).json(items);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getMediaById = async (req, res) => {
  try {
    const item = await servicesMedia.getMediaById(req.params.id);
    res.status(200).json(item);
  } catch (err) {
    res.status(404).json({ message: err.message });
  }
};

export const createMedia = async (req, res) => {
  try {
    const { title, description, mediaType } = req.body ?? {};
    if (!req.file) return res.status(400).json({ message: "File is required" });
    if (!title) return res.status(400).json({ message: "Title is required" });
    if (!["video", "audio", "text"].includes(mediaType))
      return res.status(400).json({ message: `Invalid media type: "${mediaType}"` });

    const ext = req.file.originalname.split(".").pop();
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    let s3Key;

    if (s3Configured()) {
      s3Key = `uploads/${filename}`;
      await new Upload({
        client: s3,
        params: {
          Bucket: process.env.S3_BUCKET,
          Key: s3Key,
          Body: req.file.buffer,
          ContentType: req.file.mimetype,
        },
      }).done();
    } else {
      s3Key = `local/${filename}`;
      await fs.promises.mkdir(LOCAL_UPLOAD_DIR, { recursive: true });
      await fs.promises.writeFile(path.join(LOCAL_UPLOAD_DIR, filename), req.file.buffer);
    }

    const item = await servicesMedia.createMedia({
      uploaderId: req.user.id,
      title,
      description,
      mediaType,
      s3Key,
    });
    res.status(201).json(item);
  } catch (err) {
    console.error("[createMedia error]", err);
    res.status(400).json({ message: err.message });
  }
};

export const updateMedia = async (req, res) => {
  try {
    const item = await servicesMedia.updateMedia(req.params.id, req.body);
    res.status(200).json(item);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

export const deleteMedia = async (req, res) => {
  try {
    const item = await servicesMedia.getMediaById(req.params.id);

    if (item.s3_key.startsWith("local/")) {
      const filePath = path.join(LOCAL_UPLOAD_DIR, item.s3_key.slice("local/".length));
      await fs.promises.unlink(filePath).catch(() => {});
    } else {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: item.s3_key }));
      } catch (s3Err) {
        console.error(`S3 delete failed for key ${item.s3_key}:`, s3Err.message);
      }
    }

    const result = await servicesMedia.deleteMedia(req.params.id);
    res.status(200).json(result);
  } catch (err) {
    res.status(404).json({ message: err.message });
  }
};

const WORD_MIMES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const isWordFile = (filename) => /\.(doc|docx)$/i.test(filename);

const convertWordToHtml = async (buffer) => {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{font-family:sans-serif;line-height:1.6;padding:24px;max-width:800px;margin:0 auto}</style>
</head><body>${html}</body></html>`;
};

export const streamMedia = async (req, res) => {
  try {
    const item = await servicesMedia.getMediaById(req.params.id);

    if (item.s3_key.startsWith("local/")) {
      const filename = item.s3_key.slice("local/".length);
      const filePath = path.join(LOCAL_UPLOAD_DIR, filename);

      if (isWordFile(filename)) {
        const buffer = await fs.promises.readFile(filePath);
        const html = await convertWordToHtml(buffer);
        return res.set("Content-Type", "text/html; charset=utf-8").send(html);
      }

      const stat = await fs.promises.stat(filePath);
      const contentType = getMimeType(filename);
      const range = req.headers.range;

      // A Range request means the player is seeking. Answer 206 with just the
      // requested byte slice; without this, <audio>/<video> can't scrub.
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match) {
          const start = match[1] ? parseInt(match[1], 10) : 0;
          const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;

          if (start > end || start >= stat.size || end >= stat.size) {
            return res.status(416).set("Content-Range", `bytes */${stat.size}`).end();
          }

          res.status(206);
          res.set("Content-Type", contentType);
          res.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
          res.set("Accept-Ranges", "bytes");
          res.set("Content-Length", end - start + 1);
          res.set("Content-Disposition", "inline");
          return fs.createReadStream(filePath, { start, end }).pipe(res);
        }
      }

      // No Range: send the whole file, but advertise range support so the
      // browser knows seeking is possible and will start sending Range requests.
      res.set("Content-Type", contentType);
      res.set("Content-Length", stat.size);
      res.set("Accept-Ranges", "bytes");
      res.set("Content-Disposition", "inline");
      fs.createReadStream(filePath).pipe(res);
    } else {
      const range = req.headers.range;
      const s3Response = await s3.send(
        new GetObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: item.s3_key,
          ...(range ? { Range: range } : {}),
        })
      );
      const contentType = s3Response.ContentType || "application/octet-stream";

      if (WORD_MIMES.has(contentType)) {
        const chunks = [];
        for await (const chunk of s3Response.Body) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const html = await convertWordToHtml(buffer);
        return res.set("Content-Type", "text/html; charset=utf-8").send(html);
      }

      res.set("Content-Type", contentType);
      res.set("Accept-Ranges", "bytes");
      res.set("Content-Disposition", "inline");
      if (s3Response.ContentLength) res.set("Content-Length", s3Response.ContentLength);
      // S3 returns 206 + Content-Range when it honored the Range header.
      if (range && s3Response.ContentRange) {
        res.status(206);
        res.set("Content-Range", s3Response.ContentRange);
      }
      s3Response.Body.pipe(res);
    }
  } catch (err) {
    res.status(404).json({ message: err.message });
  }
};

export const getProgress = async (req, res) => {
  try {
    const progress = await servicesMedia.getWatchProgress(req.user.id, req.params.id);
    res.status(200).json(progress);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const saveProgress = async (req, res) => {
  try {
    const { positionSeconds } = req.body;
    const progress = await servicesMedia.saveWatchProgress(req.user.id, req.params.id, positionSeconds);
    res.status(200).json(progress);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};
