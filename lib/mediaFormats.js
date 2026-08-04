// @ts-check
import path from "path";

// The single table of what this platform accepts and how it serves it back.
// The upload filter validates against it and the streaming controller derives
// Content-Type from it, so anything that can be uploaded is always something
// that can be served with the correct type.

export const MIME_TYPES = {
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

// Which media_type each extension belongs to. Lets the upload reject a "video"
// that is actually a PDF up front, instead of accepting it and having the
// transcription job die inside ffmpeg later with nothing to show the user.
export const MEDIA_TYPE_BY_EXT = {
  mp4: "video",
  webm: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  pdf: "text",
  txt: "text",
  doc: "text",
  docx: "text",
};

export const MEDIA_TYPES = ["video", "audio", "text"];

// Which text formats the AI pipeline can turn into plain text for summarising.
// Deliberately NARROWER than MEDIA_TYPE_BY_EXT: a .doc still uploads and still
// downloads, it just cannot be summarised (the legacy binary format is not what
// mammoth reads — it only handles .docx). Keeping the two tables separate is
// what lets the pipeline refuse a file up front, with a reason, instead of
// accepting the job and failing deep inside a worker with nothing to show.
//
// This lives here rather than in textExtract.js on purpose: the API process
// needs the *answer* ("can this be summarised?") to validate a trigger request,
// but must not pull in the PDF parser to get it.
export const EXTRACTABLE_TEXT_EXTS = ["txt", "docx", "pdf"];

export const isExtractableText = (filename) =>
  EXTRACTABLE_TEXT_EXTS.includes(extensionOf(filename));

// path.extname rather than split(".").pop(): the latter returns the ENTIRE
// filename when there is no dot at all, which then became the stored extension.
export const extensionOf = (filename) => path.extname(filename || "").slice(1).toLowerCase();

export const getMimeType = (filename) =>
  MIME_TYPES[extensionOf(filename)] || "application/octet-stream";
