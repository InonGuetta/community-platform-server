import * as servicesMedia from "../services/servicesMedia.js";
import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import mammoth from "mammoth";
import sanitizeHtml from "sanitize-html";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { s3, s3Configured, LOCAL_UPLOAD_DIR } from "../lib/storage.js";
import { MEDIA_TYPES, MEDIA_TYPE_BY_EXT, extensionOf, getMimeType } from "../lib/mediaFormats.js";
import { logger } from "../lib/logger.js";
import { isPrivileged } from "../lib/permissions.js";
import { requireSeconds, optionalBoolean } from "../lib/validate.js";
import { badRequest, notFound } from "../lib/AppError.js";

// s3_key is an internal storage pointer — never ship it to the client. Streaming
// and downloading go through the dedicated /:id/stream and /:id/download routes.
const publicMedia = ({ s3_key, ...rest }) => rest;

// Build a Content-Disposition that forces a download and keeps a friendly,
// UTF-8-safe filename (titles may be Hebrew). filename* carries the real name;
// filename is an ASCII fallback for older clients.
const downloadDisposition = (title, ext) => {
  const full = `${(title || "download").trim() || "download"}.${ext}`;
  const ascii = full.replace(/[^\x20-\x7E]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(full)}`;
};

export const getAllMedia = async (req, res) => {
  const { type, published, search } = req.query;
  // Non-privileged users are locked to published items regardless of the query
  // they send; only lecturers/admins may filter (or list everything).
  const publishedFilter = isPrivileged(req.user)
    ? (published !== undefined ? published === "true" : undefined)
    : true;
  const items = await servicesMedia.getAllMedia({ type, published: publishedFilter, search });
  res.status(200).json(items.map(publicMedia));
};

export const getMediaById = async (req, res) => {
  const item = await servicesMedia.getMediaById(req.params.id);
  if (!item.is_published && !isPrivileged(req.user)) {
    return res.status(404).json({ message: "Media not found" });
  }
  res.status(200).json(publicMedia(item));
};

export const createMedia = async (req, res) => {
  const { title, description, mediaType } = req.body ?? {};
  if (!req.file) throw badRequest("File is required");

  // multer has already written the file to LOCAL_UPLOAD_DIR by this point, so
  // every failure below has to remove it — otherwise a rejected upload leaves
  // an orphan on disk that nothing will ever reference or clean up. (Failures
  // during multer's own parsing — size limit, filter rejection, client abort —
  // are cleaned up by multer itself; verified against 2.2.)
  let uploadedS3Key = null;
  try {
    if (!title) throw badRequest("Title is required");
    if (!MEDIA_TYPES.includes(mediaType)) throw badRequest(`Invalid media type: "${mediaType}"`);

    // The filter already established the extension is one we accept; this
    // checks it against the media type the client declared, so an .mp3 can't be
    // filed as "video" and then queued for a transcription that dies in ffmpeg.
    const ext = extensionOf(req.file.filename);
    if (MEDIA_TYPE_BY_EXT[ext] !== mediaType) {
      throw badRequest(`A .${ext} file is ${MEDIA_TYPE_BY_EXT[ext]}, not ${mediaType}`);
    }

    let s3Key;
    if (s3Configured()) {
      s3Key = `uploads/${req.file.filename}`;
      // Stream from disk instead of holding the whole body in memory.
      await new Upload({
        client: s3,
        params: {
          Bucket: process.env.S3_BUCKET,
          Key: s3Key,
          Body: fs.createReadStream(req.file.path),
          ContentType: getMimeType(req.file.filename),
        },
      }).done();
      uploadedS3Key = s3Key;
    } else {
      // Already in the right directory under the right name — nothing to move,
      // which is what keeps this off the cross-volume rename path entirely.
      s3Key = `local/${req.file.filename}`;
    }

    const item = await servicesMedia.createMedia({
      uploaderId: req.user.id,
      title,
      description,
      mediaType,
      s3Key,
    });

    // Only redundant once the object actually lives in S3.
    if (uploadedS3Key) await fs.promises.unlink(req.file.path).catch(() => {});

    res.status(201).json(publicMedia(item));
  } catch (err) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    if (uploadedS3Key) {
      await s3
        .send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: uploadedS3Key }))
        .catch((s3Err) => logger.warn(`Could not remove orphaned S3 object ${uploadedS3Key}: ${s3Err.message}`));
    }
    throw err;
  }
};

export const updateMedia = async (req, res) => {
  const { isPublished, ...rest } = req.body ?? {};
  const item = await servicesMedia.updateMedia(req.params.id, {
    ...rest,
    isPublished: optionalBoolean(isPublished, "isPublished"),
  });
  res.status(200).json(publicMedia(item));
};

export const deleteMedia = async (req, res) => {
  const item = await servicesMedia.getMediaById(req.params.id);

  if (item.s3_key.startsWith("local/")) {
    const filePath = path.join(LOCAL_UPLOAD_DIR, item.s3_key.slice("local/".length));
    await fs.promises.unlink(filePath).catch(() => {});
  } else {
    // Best-effort: a failed object delete shouldn't block removing the DB row.
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: item.s3_key }));
    } catch (s3Err) {
      logger.warn(`S3 delete failed for key ${item.s3_key}: ${s3Err.message}`);
    }
  }

  const result = await servicesMedia.deleteMedia(req.params.id);
  res.status(200).json(result);
};

const WORD_MIMES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const isWordFile = (filename) => /\.(doc|docx)$/i.test(filename);

const convertWordToHtml = async (buffer) => {
  const { value: rawHtml } = await mammoth.convertToHtml({ buffer });
  // The DOCX is untrusted user content and we serve the result as text/html, so
  // sanitize before embedding: strip scripts/styles/handlers, keep only safe
  // formatting tags. Allow data: image URIs since mammoth inlines images.
  const html = sanitizeHtml(rawHtml, {
    allowedTags: [
      "p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre",
      "ul", "ol", "li", "strong", "em", "b", "i", "u", "sup", "sub", "a",
      "img", "table", "thead", "tbody", "tr", "td", "th", "span",
    ],
    allowedAttributes: { a: ["href", "title"], img: ["src", "alt"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https", "data"] },
  });
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{font-family:sans-serif;line-height:1.6;padding:24px;max-width:800px;margin:0 auto}</style>
</head><body>${html}</body></html>`;
};

// The DB row outlived the file/object it points at (deleted from disk, removed
// from the bucket). That's a 404 for the caller, not a server fault — which is
// what it used to surface as.
const STORAGE_NOT_FOUND = new Set(["ENOENT", "NoSuchKey", "NotFound"]);
const isStorageNotFound = (err) =>
  STORAGE_NOT_FOUND.has(err?.code) ||
  STORAGE_NOT_FOUND.has(err?.name) ||
  err?.$metadata?.httpStatusCode === 404;

// The client hung up: the user seeked, closed the tab or navigated away. On a
// media player this is constant and completely normal, so it must not be logged
// as an error or the log fills with noise and hides the real failures.
const CLIENT_ABORT_CODES = new Set(["ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET", "EPIPE"]);
const isClientAbort = (err) =>
  CLIENT_ABORT_CODES.has(err?.code) || err?.message === "aborted";

// Send a source stream to the response with cleanup on BOTH sides.
//
// .pipe() neither forwards errors nor destroys the source when the destination
// dies, so every seek or closed tab used to leave the file handle (or the S3
// socket) open — a steady leak on a server whose whole job is streaming media.
// pipeline() tears down both ends however it ends.
//
// By the time we get here the headers are already on the wire, so a failure can
// no longer become a JSON error response. Destroying the connection is the only
// correct move: the client sees a truncated response and retries the range.
export const streamToResponse = async (source, res, context) => {
  try {
    await pipeline(source, res);
  } catch (err) {
    if (isClientAbort(err)) {
      logger.debug(`[stream] client disconnected during ${context}`);
    } else {
      logger.error(`[stream] failed during ${context}: ${err.message}`);
    }
    res.destroy();
  }
};

// Returns null when there is no usable Range header, RANGE_UNSATISFIABLE when
// the request starts past the end of the file, or { start, end } otherwise.
//
// `end` is clamped to the last byte instead of rejected: RFC 9110 says a range
// overshooting the file is satisfied by what exists, and players routinely send
// a deliberately huge end value to mean "the rest". Answering 416 to those broke
// seeking. A suffix range ("bytes=-500" — the LAST 500 bytes) is also handled
// properly here; it used to be misread as "bytes=0-500".
// Exported for the range tests: the seek behaviour here is easy to break and
// the failure is a player that silently refuses to scrub.
export const RANGE_UNSATISFIABLE = Symbol("range-unsatisfiable");

export const parseRange = (header, size) => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    const suffixLength = Number(rawEnd);
    if (suffixLength <= 0) return RANGE_UNSATISFIABLE;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return RANGE_UNSATISFIABLE;

  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return RANGE_UNSATISFIABLE;

  return { start, end };
};

const streamLocalFile = async (item, req, res) => {
  const filename = item.s3_key.slice("local/".length);
  const filePath = path.join(LOCAL_UPLOAD_DIR, filename);

  if (isWordFile(filename)) {
    const buffer = await fs.promises.readFile(filePath);
    const html = await convertWordToHtml(buffer);
    return res.set("Content-Type", "text/html; charset=utf-8").send(html);
  }

  const stat = await fs.promises.stat(filePath);
  const range = parseRange(req.headers.range, stat.size);

  if (range === RANGE_UNSATISFIABLE) {
    return res.status(416).set("Content-Range", `bytes */${stat.size}`).end();
  }

  // Advertise range support even without a Range header, so the browser knows
  // seeking is possible and starts sending Range requests.
  res.set("Content-Type", getMimeType(filename));
  res.set("Accept-Ranges", "bytes");
  res.set("Content-Disposition", "inline");

  if (range) {
    res.status(206);
    res.set("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
    res.set("Content-Length", range.end - range.start + 1);
    return streamToResponse(fs.createReadStream(filePath, range), res, `stream media ${item.id}`);
  }

  res.set("Content-Length", stat.size);
  return streamToResponse(fs.createReadStream(filePath), res, `stream media ${item.id}`);
};

const streamS3Object = async (item, req, res) => {
  // S3 applies the Range itself and answers 206 + Content-Range when it honored
  // it, so the header is passed through untouched.
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
    const html = await convertWordToHtml(Buffer.concat(chunks));
    return res.set("Content-Type", "text/html; charset=utf-8").send(html);
  }

  res.set("Content-Type", contentType);
  res.set("Accept-Ranges", "bytes");
  res.set("Content-Disposition", "inline");
  if (s3Response.ContentLength) res.set("Content-Length", s3Response.ContentLength);
  if (range && s3Response.ContentRange) {
    res.status(206);
    res.set("Content-Range", s3Response.ContentRange);
  }
  return streamToResponse(s3Response.Body, res, `stream media ${item.id}`);
};

export const streamMedia = async (req, res, next) => {
  try {
    const item = await servicesMedia.getMediaById(req.params.id);
    if (!item.is_published && !isPrivileged(req.user)) {
      return res.status(404).json({ message: "Media not found" });
    }

    return item.s3_key.startsWith("local/")
      ? await streamLocalFile(item, req, res)
      : await streamS3Object(item, req, res);
  } catch (err) {
    // Only reachable before the headers went out — streamToResponse handles
    // everything after that itself.
    if (isStorageNotFound(err)) return next(notFound("Media file not found"));
    next(err);
  }
};

export const downloadMedia = async (req, res, next) => {
  try {
    const item = await servicesMedia.getMediaById(req.params.id);
    if (!item.is_published && !isPrivileged(req.user)) {
      return res.status(404).json({ message: "Media not found" });
    }
    const ext = item.s3_key.split(".").pop();

    if (item.s3_key.startsWith("local/")) {
      const filename = item.s3_key.slice("local/".length);
      const filePath = path.join(LOCAL_UPLOAD_DIR, filename);
      // stat first: a missing file must become a 404 before any header is set.
      const stat = await fs.promises.stat(filePath);
      res.set("Content-Disposition", downloadDisposition(item.title, ext));
      res.set("Content-Type", getMimeType(filename));
      res.set("Content-Length", stat.size);
      return streamToResponse(fs.createReadStream(filePath), res, `download media ${item.id}`);
    }

    const s3Response = await s3.send(
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: item.s3_key })
    );
    res.set("Content-Disposition", downloadDisposition(item.title, ext));
    res.set("Content-Type", s3Response.ContentType || "application/octet-stream");
    if (s3Response.ContentLength) res.set("Content-Length", s3Response.ContentLength);
    return streamToResponse(s3Response.Body, res, `download media ${item.id}`);
  } catch (err) {
    if (isStorageNotFound(err)) return next(notFound("Media file not found"));
    next(err);
  }
};

export const getProgress = async (req, res) => {
  const progress = await servicesMedia.getWatchProgress(req.user.id, req.params.id);
  res.status(200).json(progress);
};

export const saveProgress = async (req, res) => {
  const positionSeconds = requireSeconds(req.body?.positionSeconds, "positionSeconds");
  const progress = await servicesMedia.saveWatchProgress(req.user.id, req.params.id, positionSeconds);
  res.status(200).json(progress);
};
