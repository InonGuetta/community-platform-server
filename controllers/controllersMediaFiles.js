// @ts-check
// The routes that send a lesson's bytes: playing and reading it in the page
// (/:id/stream), saving it (/:id/download), saving a video's sound as MP3
// (/:id/download/audio), and a public lesson's player and reader for a guest
// (the public router's /media/:id/stream). Together because all four share how
// stored media is sent — ranges, documents converted for the reader, failures
// shown as a page — and the rest of the media resource needs none of it.
import fs from "fs";
import os from "os";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import * as servicesMedia from "../services/servicesMedia.js";
import { isLocalKey, localPathOf, openBucketObject, downloadToTemp, bufferOf, isStorageNotFound } from "../lib/storage.js";
import { extensionOf, getMimeType, isViewableText } from "../lib/mediaFormats.js";
import { decodeTextBuffer } from "../lib/textEncoding.js";
import { streamToResponse, parseRange, RANGE_UNSATISFIABLE, isClientAbort } from "../lib/httpStream.js";
import { convertWordToHtml } from "../lib/wordToHtml.js";
import { logger } from "../lib/logger.js";
import { AppError, badRequest, notFound, ERROR_CODES } from "../lib/AppError.js";
// The guard for a lesson this caller may not see, and the 404 it answers.
import { canUserSeeMedia, assertUserCanSeeMediaId, hiddenMediaError } from "../services/servicesVisibility.js";

// Same bundled binary the transcription worker uses, so the API and the worker
// cannot end up transcoding with two different ffmpeg builds.
ffmpeg.setFfmpegPath(ffmpegPath);

// Build a Content-Disposition that forces a download and keeps a friendly,
// UTF-8-safe filename (titles may be Hebrew). filename* carries the real name;
// filename is an ASCII fallback for older clients.
const downloadDisposition = (title, ext) => {
  const full = `${(title || "download").trim() || "download"}.${ext}`;
  const ascii = full.replace(/[^\x20-\x7E]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(full)}`;
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

const streamLocalFile = async (item, req, res) => {
  // The checks below read only the extension, so the key serves as the name.
  const filename = item.s3_key;
  const filePath = localPathOf(item.s3_key);

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
  // it, so the header is passed through untouched — for media only.
  //
  // A .txt or a Word file is converted whole below (decoded, or turned into
  // HTML), so it must be FETCHED whole. Forwarding a Range for those returned
  // part of the object, which was then decoded as if complete (truncated text)
  // or handed to mammoth as a partial zip (DOCUMENT_UNREADABLE). Decided by the
  // extension, before the request, exactly as streamLocalFile decides it.
  const convertedWhole = isPlainText(item.s3_key) || isWordFile(item.s3_key);
  const range = convertedWhole ? undefined : req.headers.range;
  const object = await openBucketObject(item.s3_key, { range });
  const contentType = object.contentType || "application/octet-stream";

  if (contentType.startsWith("text/plain")) {
    return sendDecodedText(await bufferOf(object.stream), res);
  }

  if (WORD_MIMES.has(contentType)) {
    const html = await convertWordToHtml(await bufferOf(object.stream));
    return res.set("Content-Type", "text/html; charset=utf-8").send(html);
  }

  res.set("Content-Type", contentType);
  res.set("Accept-Ranges", "bytes");
  res.set("Content-Disposition", "inline");
  if (object.contentLength) res.set("Content-Length", object.contentLength);
  if (range && object.contentRange) {
    res.status(206);
    res.set("Content-Range", object.contentRange);
  }
  return streamToResponse(object.stream, res, `stream media ${item.id}`);
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
    // Straight to next(), not thrown: the catch below turns an error into the
    // HTML page when a browser asked for one, and a hidden lesson has always
    // answered the JSON 404 here, even then — while a missing one gets the page
    // (test/mediaVisibilityGuard.test.js pins both). Making the two match is a
    // change of behaviour to make on purpose, not in passing.
    if (!(await canUserSeeMedia(req.user, item))) return next(hiddenMediaError());

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

    return isLocalKey(item.s3_key)
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
    const item = await assertUserCanSeeMediaId(req.user, req.params.id);
    // extensionOf, not split(".").pop(): for a key with no dot the latter is the
    // whole key, and the download was named "<title>.local/1700-abc".
    const ext = extensionOf(item.s3_key) || "bin";

    if (isLocalKey(item.s3_key)) {
      const filePath = localPathOf(item.s3_key);
      // stat first: a missing file must become a 404 before any header is set.
      const stat = await fs.promises.stat(filePath);
      res.set("Content-Disposition", downloadDisposition(item.title, ext));
      res.set("Content-Type", getMimeType(item.s3_key));
      res.set("Content-Length", stat.size);
      return streamToResponse(fs.createReadStream(filePath), res, `download media ${item.id}`);
    }

    const object = await openBucketObject(item.s3_key);
    res.set("Content-Disposition", downloadDisposition(item.title, ext));
    res.set("Content-Type", object.contentType || "application/octet-stream");
    if (object.contentLength) res.set("Content-Length", object.contentLength);
    return streamToResponse(object.stream, res, `download media ${item.id}`);
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
  if (isLocalKey(s3Key)) {
    const filePath = localPathOf(s3Key);
    await fs.promises.stat(filePath); // 404 before any header goes out
    return { path: filePath, isTemp: false };
  }
  return { path: await downloadToTemp(s3Key, { dir: os.tmpdir(), prefix: "dl-" }), isTemp: true };
};

// "Download this lecture as audio" for a video. The audio track is extracted on
// demand rather than stored twice: an MP3 of a talking-head lecture is a small
// fraction of the video, and keeping a second rendition per item in sync with
// uploads, deletes and re-uploads is a much bigger commitment than a transcode.
//
// 128kbps stereo, unlike the transcription worker's 16kHz mono 64k — that one
// feeds Whisper, this one is for a person to listen to.
//
// Each extraction is a full ffmpeg transcode on the API host. The route limits
// how often one user may ask; this caps how many run at once across everybody,
// so a burst cannot starve the requests the API exists to answer. A refusal is
// a 429 the user can retry in a moment, not a queue nobody can see.
const MAX_CONCURRENT_AUDIO_EXTRACTS = 3;
let activeAudioExtracts = 0;

export const downloadMediaAudio = async (req, res, next) => {
  let temp = null;
  let holdsSlot = false;
  try {
    const item = await assertUserCanSeeMediaId(req.user, req.params.id);
    // Audio items already have their own download; documents have no audio at
    // all. Only a video needs this route, so anything else is a client mistake.
    if (item.media_type !== "video") {
      return next(badRequest("Audio extraction is only available for video items"));
    }

    if (activeAudioExtracts >= MAX_CONCURRENT_AUDIO_EXTRACTS) {
      res.set("Retry-After", "30");
      return next(new AppError("The server is busy preparing other audio downloads — try again in a moment", 429));
    }
    activeAudioExtracts++;
    holdsSlot = true;

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
    if (holdsSlot) activeAudioExtracts--;
    if (temp) fs.promises.rm(temp, { force: true }).catch(() => {});
  }
};

// ── A public lesson's bytes, for a guest with the link (PRD COM-3b) ─────────
//
// No session: what makes it safe is the row — public AND published, checked on
// every request by getPublicMedia. A lesson that is not public is the same 404
// as one that does not exist. Mounted by routes/routersPublic.js.
export const streamPublicMedia = async (req, res, next) => {
  try {
    const item = await servicesMedia.getPublicMedia(req.params.id);
    if (!item) throw notFound("Media not found", ERROR_CODES.MEDIA_NOT_FOUND);
    if (item.media_type === "text" && !isViewableText(item.s3_key)) {
      throw badRequest("This file cannot be displayed", ERROR_CODES.UNVIEWABLE_TEXT_FORMAT);
    }
    return isLocalKey(item.s3_key)
      ? await streamLocalFile(item, req, res)
      : await streamS3Object(item, req, res);
  } catch (err) {
    next(isStorageNotFound(err) ? notFound("Media file not found", ERROR_CODES.MEDIA_NOT_FOUND) : err);
  }
};
