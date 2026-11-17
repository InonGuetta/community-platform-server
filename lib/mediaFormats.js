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
  // Profile pictures (services/servicesAvatars.js) — served, never accepted
  // as media: MEDIA_TYPE_BY_EXT below does not list them.
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
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

// Which text formats can be shown INLINE in the reader's "מקור" tab.
//
// A third table, and it is not the same question as either of the two above.
// MEDIA_TYPE_BY_EXT says what may be uploaded; EXTRACTABLE_TEXT_EXTS says what
// the AI pipeline can read. This says what a browser can be handed.
//
// .doc is the one that differs, and it is why this exists. It uploads, it
// downloads, and it cannot be displayed: the viewer converts Word to HTML with
// mammoth, which reads the DOCX zip format and not the legacy binary one — so a
// .doc reached the converter, threw somewhere inside it, and surfaced as a
// generic 500 on a file the server was never able to show. Naming the limit here
// turns that into an answer the user can act on.
export const VIEWABLE_TEXT_EXTS = ["txt", "docx", "pdf"];

export const isViewableText = (filename) =>
  VIEWABLE_TEXT_EXTS.includes(extensionOf(filename));

// path.extname rather than split(".").pop(): the latter returns the ENTIRE
// filename when there is no dot at all, which then became the stored extension.
export const extensionOf = (filename) => path.extname(filename || "").slice(1).toLowerCase();

export const getMimeType = (filename) =>
  MIME_TYPES[extensionOf(filename)] || "application/octet-stream";

// ── Profile pictures ────────────────────────────────────────────────────────
//
// What a picture IS, read from its first bytes rather than from its name or
// the type the browser declared: both are the sender's word. Only the three
// formats every browser draws, and never SVG — an SVG is a document that can
// carry script, and it would be served from this API's own origin.
const IMAGE_SIGNATURES = [
  { ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  {
    ext: "webp",
    test: (b) => b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
  },
];

/**
 * The extension a picture's bytes say it is ("jpg", "png", "webp"), or null.
 * @param {Buffer | null | undefined} buffer
 */
export const imageTypeOf = (buffer) => {
  if (!buffer || buffer.length < 12) return null;
  return IMAGE_SIGNATURES.find((s) => s.test(buffer))?.ext ?? null;
};
