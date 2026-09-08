// @ts-check
import * as servicesMedia from "../services/servicesMedia.js";
import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import mammoth from "mammoth";
import sanitizeHtml from "sanitize-html";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { pipeline } from "stream/promises";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { s3, s3Configured, LOCAL_UPLOAD_DIR } from "../lib/storage.js";
import { MEDIA_TYPES, MEDIA_TYPE_BY_EXT, extensionOf, getMimeType, isViewableText } from "../lib/mediaFormats.js";
import { decodeTextBuffer } from "../lib/textEncoding.js";
import { logger } from "../lib/logger.js";
import { env } from "../lib/env.js";
import { isPrivileged, assertCanManageMedia } from "../lib/permissions.js";
import { viewerScopeFor, canUserSeeMedia } from "../services/servicesVisibility.js";
import { requireSeconds, optionalBoolean, optionalId, tagIdFilter } from "../lib/validate.js";
import { setMediaTags, cleanTagSelection, getTagTree } from "../services/servicesTags.js";
import { suggestTags } from "../lib/tagSuggestions.js";
import { badRequest, notFound, ERROR_CODES } from "../lib/AppError.js";

// Same bundled binary the transcription worker uses, so the API and the worker
// cannot end up transcoding with two different ffmpeg builds.
ffmpeg.setFfmpegPath(ffmpegPath);

// s3_key is an internal storage pointer — never ship it to the client. Streaming
// and downloading go through the dedicated /:id/stream and /:id/download routes.
//
// Two facts ARE derived from it on the way out, because the client cannot work
// them out for itself and guessing costs it a wasted request:
//
//   file_ext        what kind of file this is, for wording and icons. The
//                   extension alone leaks nothing — it is not a path.
//
//   can_view_inline whether the reader may embed it. Computed HERE, by the same
//                   isViewableText the streaming route refuses with, so the rule
//                   lives in one place. Sending the extension alone would make
//                   the client re-implement the list, which is the cross-file
//                   pair this codebase keeps getting bitten by.
//
//                   null for audio and video: the question is about documents,
//                   and answering "false" for a lecture would read as a fault.
//
// It matters because the reader now points an <iframe> straight at the stream
// route. A file that route refuses answers 400 with a JSON body, and an iframe
// renders that JSON as text — so the client has to know NOT to embed it, rather
// than finding out by embedding it.
const publicMedia = ({ s3_key, ...rest }) => ({
  ...rest,
  file_ext: extensionOf(s3_key),
  can_view_inline: rest.media_type === "text" ? isViewableText(s3_key) : null,
});

// Four handlers here load a media item and then have to decide whether this
// caller may see it — the read, the stream, the download and the audio extract.
// All four answered 404 rather than 403 for the same reason (an item a student
// may not see must be indistinguishable from one that does not exist, or the id
// space becomes a way to enumerate the library), and all four wrote that answer
// out separately.
//
// Returns true when it has already answered, so a call site reads as one line:
// `if (await refuseIfHidden(req, res, item)) return;`.
//
// That shape was chosen in anticipation of exactly this change, and it paid: the
// enrolment rule made the predicate asynchronous, and one function learned to
// await rather than four.
const refuseIfHidden = async (req, res, item) => {
  if (await canUserSeeMedia(req.user, item)) return false;
  res.status(404).json({ message: "Media not found", code: ERROR_CODES.MEDIA_NOT_FOUND });
  return true;
};

// Build a Content-Disposition that forces a download and keeps a friendly,
// UTF-8-safe filename (titles may be Hebrew). filename* carries the real name;
// filename is an ASCII fallback for older clients.
const downloadDisposition = (title, ext) => {
  const full = `${(title || "download").trim() || "download"}.${ext}`;
  const ascii = full.replace(/[^\x20-\x7E]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(full)}`;
};

export const getAllMedia = async (req, res) => {
  const { type, published, search, courseId, creator, tagIds, excludeTagIds, uploadedAfter, uploadedBefore } =
    req.query;

  const parsedTagIds = tagIdFilter(tagIds, "tagIds");
  const parsedExcludeTagIds = tagIdFilter(excludeTagIds, "excludeTagIds");
  // Asking for a branch and asking for it to be left out is a contradiction, and
  // the query would honour the exclusion and answer with nothing. An empty
  // archive is exactly how somebody concludes the filter is broken, so it is
  // said out loud instead.
  const contradiction = parsedTagIds.find((id) => parsedExcludeTagIds.includes(id));
  if (contradiction !== undefined) {
    throw badRequest("A tag cannot be both chosen and excluded");
  }

  const privileged = isPrivileged(req.user);
  // Resolved ONCE. For a student this costs an enrolment query, so calling it
  // per field would double it on the busiest read in the application.
  const scope = await viewerScopeFor(req.user);

  const items = await servicesMedia.getAllMedia({
    type,
    // The access rule, applied by the service unconditionally. It used to be
    // expressed as `published: true` for a student — a filter in the same slot
    // as the caller's own — so the rule and the preference were one field, and
    // whether a draft was hidden depended on the controller remembering to set
    // it. They are now separate arguments because they are separate things.
    //
    // Both halves are passed, and both matter: courses decides which PUBLISHED
    // lessons, drafts decides WHOSE unpublished ones. Passing only the first
    // would fail closed on drafts — the safe direction, but silently wrong for
    // the lecturer whose own work in progress would vanish from their archive.
    visibleCourses: scope.courses,
    visibleDrafts: scope.drafts,
    // A narrowing filter the caller chooses. It can only shrink what they were
    // already entitled to, and it is meaningless to anyone who cannot see drafts
    // in the first place — so it is read only for a privileged caller.
    published: privileged && published !== undefined ? published === "true" : undefined,
    search,
    creator,
    // Two lists, and they are not opposites of one another: one says which
    // branches to look in, the other says which parts of them to leave out.
    // "Everything in תורה except שמות" needs both, and could not be said with
    // either alone — see servicesMedia for why naming the four books to keep
    // returns nothing at all.
    //
    // Ids rather than names because the taxonomy repeats five names across
    // branches. Parsed by the shared guard so that both lists refuse the same
    // things: a non-numeric entry is a 400 rather than a value dropped on the
    // floor, which would answer a filter nobody asked for.
    tagIds: parsedTagIds,
    excludeTagIds: parsedExcludeTagIds,
    uploadedAfter,
    uploadedBefore,
    ...(courseId !== undefined && { courseId: optionalId(courseId, "courseId") }),
  });
  res.status(200).json(items.map(publicMedia));
};

export const getMediaById = async (req, res) => {
  const item = await servicesMedia.getMediaById(req.params.id);
  if (await refuseIfHidden(req, res, item)) return;
  res.status(200).json(publicMedia(item));
};

export const createMedia = async (req, res) => {
  const { title, description, mediaType, courseId, lecturerId, creatorName, tags: tagNames, tagIds } = req.body ?? {};
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

    // Checked HERE, before the file is stored and the row is inserted, because
    // this is the only kind of tagging failure that is the caller's fault. A
    // refusal raised after the upload leaves an item whose file the catch below
    // then deletes — the row survives, pointing at nothing, and the 400 the
    // caller sees is about tags while what actually happened is that their
    // upload was destroyed.
    const chosenTags =
      tagIds !== undefined || tagNames !== undefined
        ? cleanTagSelection({
            ids: tagIds === undefined ? [] : [].concat(tagIds).map(Number),
            names: tagNames === undefined ? [] : [].concat(tagNames),
          })
        : null;

    let s3Key;
    if (s3Configured()) {
      s3Key = `uploads/${req.file.filename}`;
      // Stream from disk instead of holding the whole body in memory.
      await new Upload({
        client: s3,
        params: {
          Bucket: env.s3Bucket,
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
      // Both optional: an unassigned upload lands in the general library, which
      // is what every item predating courses already is.
      courseId: optionalId(courseId, "courseId"),
      lecturerId: optionalId(lecturerId, "lecturerId"),
      // Passed raw. Trimming, the blank-to-"כללי" fallback and the length check
      // all live in servicesMedia, so a caller that skips this form gets the
      // same rules — see cleanCreatorName there.
      creatorName,
    });

    // After the row exists, because a tag needs something to attach to.
    //
    // Anything that goes wrong at THIS point is infrastructure, not input — the
    // selection was checked above — so it must not take the upload down with it:
    // a throw here reaches the catch, which deletes a file that may be hundreds
    // of megabytes and has already been stored, while the row it belongs to
    // stays behind. An item that is merely untagged is recoverable from its own
    // card in the archive; one whose file is gone is not.
    let created = item;
    if (chosenTags) {
      try {
        await setMediaTags(item.id, chosenTags);
        // Read again, for the same reason updateMedia does: the row above was
        // produced before the tags existed, and the client replaces its copy of
        // the item with whatever comes back. Returning the pre-tag row made an
        // item uploaded WITH tags render as untagged — and opening the tag
        // dialog on it then seeded an empty picker whose save wiped them.
        created = await servicesMedia.getMediaById(item.id);
      } catch (err) {
        logger.warn(`[BE:ctl] createMedia — tagging item ${item.id} failed: ${err.message}`);
      }
    }

    // Only redundant once the object actually lives in S3.
    if (uploadedS3Key) await fs.promises.unlink(req.file.path).catch(() => {});

    res.status(201).json(publicMedia(created));
  } catch (err) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    if (uploadedS3Key) {
      await s3
        .send(new DeleteObjectCommand({ Bucket: env.s3Bucket, Key: uploadedS3Key }))
        .catch((s3Err) => logger.warn(`Could not remove orphaned S3 object ${uploadedS3Key}: ${s3Err.message}`));
    }
    throw err;
  }
};

export const updateMedia = async (req, res) => {
  const body = req.body ?? {};
  const { isPublished, courseId, lecturerId, ...rest } = body;
  // Ownership is checked here rather than in the route because requireRole runs
  // before the item exists. This body carries isPublished, so without the check a
  // lecturer could unpublish another lecturer's material.
  assertCanManageMedia(req.user, await servicesMedia.getMediaById(req.params.id));
  let item = await servicesMedia.updateMedia(req.params.id, {
    ...rest,
    isPublished: optionalBoolean(isPublished, "isPublished"),
    // Presence in the body — not the value — is what says "change this". Sending
    // courseId: null detaches the lesson from its course; omitting the key
    // entirely leaves whatever is there alone.
    setCourse: "courseId" in body,
    courseId: optionalId(courseId, "courseId"),
    setLecturer: "lecturerId" in body,
    lecturerId: optionalId(lecturerId, "lecturerId"),
  });

  // Presence in the body decides, as it does for the two associations above:
  // sending an empty list clears the tags, omitting the key leaves them alone.
  if ("tags" in body || "tagIds" in body) {
    await setMediaTags(req.params.id, {
      ids: [].concat(body.tagIds ?? []).map(Number),
      names: [].concat(body.tags ?? []),
    });
    // Read AGAIN, because the row above was read before the tags were written
    // and still carries the old ones. The client replaces its copy of the item
    // with whatever comes back here, so returning the stale row meant tags saved
    // from the dialog did not appear on the card until something else caused a
    // refetch — opening the lesson and coming back. The item looked untagged
    // while the database said otherwise, which is the worst version of this bug:
    // the save worked and the screen said it had not.
    item = await servicesMedia.getMediaById(req.params.id);
  }
  res.status(200).json(publicMedia(item));
};

export const deleteMedia = async (req, res) => {
  const item = await servicesMedia.getMediaById(req.params.id);
  // Before the unlink below, not after: this deletes the stored file itself, so
  // a refused caller must not get as far as touching storage.
  assertCanManageMedia(req.user, item);

  if (item.s3_key.startsWith("local/")) {
    const filePath = path.join(LOCAL_UPLOAD_DIR, item.s3_key.slice("local/".length));
    await fs.promises.unlink(filePath).catch(() => {});
  } else {
    // Best-effort: a failed object delete shouldn't block removing the DB row.
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: env.s3Bucket, Key: item.s3_key }));
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
const isPlainText = (filename) => extensionOf(filename) === "txt";

// A .txt, served so a browser renders it as the words it holds.
//
// text/plain carries no encoding of its own, and a response that does not name
// one leaves the browser to guess — which it does NOT do as UTF-8. A Hebrew file
// therefore arrived as mojibake in the reader's frame however it was written.
//
// Declaring "; charset=utf-8" over the raw bytes would only make that
// deterministic rather than occasional: Hebrew .txt files in the wild are
// frequently windows-1255, which is exactly why lib/textEncoding.js exists and
// why the extraction path has always decoded rather than assumed. So the bytes
// are decoded with the same rule and re-encoded as UTF-8 — the header is then
// true because the body was made true, rather than asserted and hoped for.
//
// This gives up Range support for .txt, which costs nothing: the reader fetches
// the whole file into a blob before showing it, and nobody seeks a text file.
const sendDecodedText = (buffer, res) => {
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Content-Disposition", "inline");
  return res.send(Buffer.from(decodeTextBuffer(buffer), "utf-8"));
};

const convertWordToHtml = async (buffer) => {
  // mammoth throws from inside the zip reader on a file that is corrupt,
  // truncated, or simply not the DOCX it claims to be. That is a problem with
  // THIS FILE, not with the server, and it arrived as a 500 — which reads as a
  // fault and tells the user nothing they can act on. Same treatment, and the
  // same wording, that lib/textExtract.js already gives the extraction path.
  let rawHtml;
  try {
    ({ value: rawHtml } = await mammoth.convertToHtml({ buffer }));
  } catch (err) {
    throw badRequest(
      `Could not read this document — it may be corrupt or password-protected. (${err.message})`,
      ERROR_CODES.DOCUMENT_UNREADABLE
    );
  }
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

  if (isPlainText(filename)) {
    return sendDecodedText(await fs.promises.readFile(filePath), res);
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
      Bucket: env.s3Bucket,
      Key: item.s3_key,
      ...(range ? { Range: range } : {}),
    })
  );
  const contentType = s3Response.ContentType || "application/octet-stream";

  if (contentType.startsWith("text/plain")) {
    const stream = /** @type {import("stream").Readable} */ (s3Response.Body);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return sendDecodedText(Buffer.concat(chunks), res);
  }

  if (WORD_MIMES.has(contentType)) {
    // Same narrowing as lib/storage.js: the SDK types Body as a union spanning
    // every runtime it supports, and only the Node Readable in that union can be
    // iterated with `for await`. On Node it is always the Readable.
    const stream = /** @type {import("stream").Readable} */ (s3Response.Body);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
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

// ── Failing legibly, now that a browser renders this route directly ────────
//
// The reader used to fetch this through axios and parse the JSON body of a
// failure. It now points an <iframe> at the URL, so a failure is DISPLAYED: a
// JSON body shown as text inside the reader looks like the document itself,
// which is worse than an error message.
//
// The discriminator is the Accept header, which separates the two callers
// cleanly — a frame navigation asks for text/html, axios asks for
// application/json. Anything that is not a browser keeps the JSON it expects.
const wantsAPage = (req) => req.accepts(["json", "html"]) === "html";

// Hebrew, and rendered by the server rather than keyed by a code on the client
// — because there is no client on this path. It is the same reasoning that keeps
// lib/textExtract.js's refusals in Hebrew: they are stored and shown verbatim,
// with no code anywhere near them.
const PAGE_MESSAGE = {
  [ERROR_CODES.UNVIEWABLE_TEXT_FORMAT]:
    "לא ניתן להציג כאן קובץ מסוג זה. אפשר להוריד אותו ולפתוח במחשב.",
  [ERROR_CODES.DOCUMENT_UNREADABLE]:
    "לא ניתן לקרוא את הקובץ — ייתכן שהוא פגום או מוגן בסיסמה.",
  [ERROR_CODES.MEDIA_NOT_FOUND]: "הקובץ לא נמצא.",
};

const errorPage = (err) => {
  const message = PAGE_MESSAGE[err?.code] || "לא ניתן להציג את המסמך.";
  // The message is one of the fixed strings above, never anything from the
  // request or the file, so there is nothing here to escape.
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">` +
    `<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;` +
    `padding:40px 24px;text-align:center;color:#43606d;background:#f3f5f7;line-height:1.7}</style>` +
    `</head><body>${message}</body></html>`;
};

export const streamMedia = async (req, res, next) => {
  try {
    const item = await servicesMedia.getMediaById(req.params.id);
    if (await refuseIfHidden(req, res, item)) return;

    // Refused HERE rather than discovered inside the converter.
    //
    // A .doc uploads and downloads perfectly well and cannot be displayed: the
    // Word branch below hands it to mammoth, which reads the DOCX zip and not
    // the legacy binary format, so it threw somewhere inside the parser and
    // arrived as a generic 500 — on a file the server was never going to be able
    // to show. The user was told the document failed to load, which reads as a
    // fault and invites a retry that cannot work.
    //
    // Only for text: an .mp4 has no business being asked this question, and
    // isViewableText would answer no for every recording in the archive.
    if (item.media_type === "text" && !isViewableText(item.s3_key)) {
      throw badRequest(
        `A .${extensionOf(item.s3_key)} file cannot be displayed. Supported: PDF, DOCX, TXT.`,
        ERROR_CODES.UNVIEWABLE_TEXT_FORMAT
      );
    }

    return item.s3_key.startsWith("local/")
      ? await streamLocalFile(item, req, res)
      : await streamS3Object(item, req, res);
  } catch (err) {
    // Only reachable before the headers went out — streamToResponse handles
    // everything after that itself.
    const failure = isStorageNotFound(err)
      ? notFound("Media file not found", ERROR_CODES.MEDIA_NOT_FOUND)
      : err;

    if (failure?.expose && wantsAPage(req)) {
      return res.status(failure.statusCode).type("html").send(errorPage(failure));
    }
    next(failure);
  }
};

export const downloadMedia = async (req, res, next) => {
  try {
    const item = await servicesMedia.getMediaById(req.params.id);
    if (await refuseIfHidden(req, res, item)) return;
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
      new GetObjectCommand({ Bucket: env.s3Bucket, Key: item.s3_key })
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

// Put the stored object somewhere ffmpeg can seek. An MP4's moov atom may sit at
// the end of the file, so ffmpeg has to be able to jump around the input — a
// piped S3 stream cannot do that, which is why a remote object is staged to a
// temp file first. A local upload is already a seekable path and is used in
// place.
const resolveSeekablePath = async (s3Key) => {
  if (s3Key.startsWith("local/")) {
    const filePath = path.join(LOCAL_UPLOAD_DIR, s3Key.slice("local/".length));
    await fs.promises.stat(filePath); // 404 before any header goes out
    return { path: filePath, isTemp: false };
  }
  const { Body } = await s3.send(new GetObjectCommand({ Bucket: env.s3Bucket, Key: s3Key }));
  // The SDK types Body as a union covering every runtime it supports; on Node it
  // is always a Readable. Same narrowing as readMediaBuffer in lib/storage.js.
  const stream = /** @type {import("stream").Readable} */ (Body);
  const tmpPath = path.join(os.tmpdir(), `dl-${randomUUID()}${path.extname(s3Key)}`);
  await pipeline(stream, fs.createWriteStream(tmpPath));
  return { path: tmpPath, isTemp: true };
};

// "Download this lecture as audio" for a video. The audio track is extracted on
// demand rather than stored twice: an MP3 of a talking-head lecture is a small
// fraction of the video, and keeping a second rendition per item in sync with
// uploads, deletes and re-uploads is a much bigger commitment than a transcode.
//
// 128kbps stereo, unlike the transcription worker's 16kHz mono 64k — that one
// feeds Whisper, this one is for a person to listen to.
export const downloadMediaAudio = async (req, res, next) => {
  let temp = null;
  try {
    const item = await servicesMedia.getMediaById(req.params.id);
    if (await refuseIfHidden(req, res, item)) return;
    // Audio items already have their own download; documents have no audio at
    // all. Only a video needs this route, so anything else is a client mistake.
    if (item.media_type !== "video") {
      return next(badRequest("Audio extraction is only available for video items"));
    }

    const source = await resolveSeekablePath(item.s3_key);
    temp = source.isTemp ? source.path : null;

    res.set("Content-Disposition", downloadDisposition(item.title, "mp3"));
    res.set("Content-Type", "audio/mpeg");
    // No Content-Length on purpose: the size is not known until the transcode
    // finishes, and buffering the whole thing just to announce it would delay
    // the download by the length of the lecture.

    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const command = ffmpeg(source.path)
        .noVideo()
        .audioCodec("libmp3lame")
        .audioBitrate("128k")
        .format("mp3")
        .on("error", (err) => {
          // A client that navigates away kills the pipe; ffmpeg reports that as
          // an error but it is the same non-event it is for a media stream.
          if (isClientAbort(err) || res.destroyed) {
            logger.debug(`[audio] client disconnected during extract ${item.id}`);
            return resolve();
          }
          reject(new Error(`ffmpeg failed: ${err.message}`));
        })
        .on("end", resolve);

      // Kill the transcode when the client hangs up, or ffmpeg keeps burning CPU
      // on a lecture nobody is downloading any more.
      res.on("close", () => { if (!res.writableFinished) command.kill("SIGKILL"); });
      command.pipe(res, { end: true });
    }));
  } catch (err) {
    if (isStorageNotFound(err)) return next(notFound("Media file not found"));
    // Headers may already be on the wire by the time a transcode fails, and then
    // there is no way back to a JSON error — same reasoning as streamToResponse.
    if (res.headersSent) {
      logger.error(`[audio] failed mid-stream: ${err.message}`);
      return res.destroy();
    }
    next(err);
  } finally {
    if (temp) fs.promises.rm(temp, { force: true }).catch(() => {});
  }
};

// The shelf that answers "where was I". The watch position has been recorded
// since the player was written and was only ever read back one lecture at a time,
// to resume it — so the data to build this had been accumulating all along with
// nothing reading it across items.
export const getContinueWatching = async (req, res) => {
  const items = await servicesMedia.getContinueWatching(
    req.user.id,
    await viewerScopeFor(req.user)
  );
  res.status(200).json(items.map(publicMedia));
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

// Every tag in use, with how many items carry it. Feeds the upload form's
// autocomplete and the archive's filter — both of which need the same list, so
// it is one endpoint rather than two shapes of the same query.
// The creator list for the filter menu. Its own endpoint because the listing is
// now filtered server-side, and a menu built from filtered rows closes on
// whatever was chosen.
export const getCreators = async (req, res) => {
  res.status(200).json(await servicesMedia.getCreators(await viewerScopeFor(req.user)));
};

// What this item looks like it is about, offered to whoever may tag it.
//
// A first guess from the title, never applied on its own — see
// lib/tagSuggestions.js for what it can and cannot know. It exists because the
// alternative, which this archive ran on until now, is that items arrive
// untagged and stay that way: every filter in the application was a control over
// an empty set, and asking again after the upload, with a starting point, is the
// cheapest moment to fix that.
//
// Ownership is checked, not just the role: a suggestion is about a particular
// item, and offering it discloses that item's title to whoever asked.
export const getTagSuggestions = async (req, res) => {
  const item = await servicesMedia.getMediaById(req.params.id);
  assertCanManageMedia(req.user, item);
  const tags = await getTagTree();
  res.status(200).json(suggestTags(item, tags));
};

export const getTags = async (req, res) => {
  // The counts are per VIEWER: a student must not be offered "7" beside a branch
  // that answers with three. Same scope object the listing resolves, so the
  // number on a chip and the rows behind it are decided by one rule.
  const scope = await viewerScopeFor(req.user);
  res.status(200).json(await getTagTree({ visibleCourses: scope.courses, visibleDrafts: scope.drafts }));
};

