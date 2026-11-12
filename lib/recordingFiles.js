// @ts-check
// ── A session recording's files (PRD REC-1) ─────────────────────────────────
//
// The numbered parts on disk while a recording runs, and the one file they
// are joined into when it ends — files and ffmpeg only. Which recording, whose
// it is and what state it is in are rows, and services/servicesSessionRecordings.js
// keeps those; it calls these to do the file work.
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { pipeline } from "stream/promises";
import { execFile } from "child_process";
import ffmpegPath from "ffmpeg-static";
import { logger } from "./logger.js";
import { LOCAL_UPLOAD_DIR, isLocalKey, localKeyFor, localPathOf, storeFile } from "./storage.js";
import { probeDurationSeconds } from "./mediaDuration.js";

// Where the parts wait until the recording is finished. Under the uploads
// directory, so it is on the same volume as the final file.
export const PARTS_DIR = path.join(LOCAL_UPLOAD_DIR, "recording-parts");

const extensionFor = (mimeType) => {
  if (/ogg/i.test(mimeType)) return "ogg";
  // .mp4, not .m4a: lib/mediaFormats.js serves what it lists, and m4a is not
  // in it — Safari records audio/mp4, which plays from an .mp4 like any other.
  if (/mp4/i.test(mimeType)) return "mp4";
  return "webm";
};

// See lib/mediaDuration.js for why the default import is restated.
const FFMPEG = /** @type {string | null} */ (/** @type {unknown} */ (ffmpegPath));
const REMUX_TIMEOUT_MS = 10 * 60_000;

/**
 * Rewrite the joined file's container without touching the audio (-c copy).
 * A MediaRecorder stream is written as it is recorded, so its header never
 * learns how long it became — ffprobe says "Duration: N/A", and so would the
 * lesson this recording turns into. Remuxing writes the length in. Best
 * effort: on any failure the joined file stands as it is, still playable.
 * @param {string} file
 */
const remuxInPlace = async (file) => {
  if (!FFMPEG) return false;
  const fixed = `${file}.remux${path.extname(file)}`;
  try {
    await new Promise((resolve, reject) => {
      execFile(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-c", "copy", fixed],
        { timeout: REMUX_TIMEOUT_MS }, (err) => (err ? reject(err) : resolve(undefined)));
    });
    await fsp.rename(fixed, file);
    return true;
  } catch (err) {
    logger.warn(`[BE:svc] recording remux failed, keeping the joined file — ${err.message}`);
    await fsp.rm(fixed, { force: true });
    return false;
  }
};

const partsDirOf = (recordingId) => path.join(PARTS_DIR, String(recordingId));
const partPath = (recordingId, n) => path.join(partsDirOf(recordingId), `${String(n).padStart(5, "0")}.part`);

/** @param {number} recordingId */
export const createPartsDir = (recordingId) => fsp.mkdir(partsDirOf(recordingId), { recursive: true });

/**
 * Store one numbered part; the same number again replaces it.
 * @param {number} recordingId
 * @param {number} partNumber
 * @param {Buffer} body
 */
export const writePart = async (recordingId, partNumber, body) => {
  // Written beside its final name and renamed into place, so a part is either
  // all there or not there — a half-written one would be joined into the file.
  const dir = partsDirOf(recordingId);
  await fsp.mkdir(dir, { recursive: true });
  const target = partPath(recordingId, partNumber);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, body);
  await fsp.rename(temp, target);
};

/** Everything a recording left in the parts directory. @param {number} recordingId */
export const removeParts = (recordingId) => fsp.rm(partsDirOf(recordingId), { recursive: true, force: true });

/**
 * The gapless run of parts from 0 that is on disk: [paths, bytes].
 * @param {number} recordingId
 */
export const contiguousParts = async (recordingId) => {
  let names;
  try {
    names = await fsp.readdir(partsDirOf(recordingId));
  } catch {
    return { files: [], bytes: 0 };
  }
  const present = new Set(names.filter((n) => /^\d{5}\.part$/.test(n)).map((n) => Number(n.slice(0, 5))));
  const files = [];
  let bytes = 0;
  for (let n = 0; present.has(n); n += 1) {
    const file = partPath(recordingId, n);
    files.push(file);
    bytes += (await fsp.stat(file)).size;
  }
  return { files, bytes };
};

// Join the parts into one file and put it where media lives. Returns the
// stored key, or null when there was nothing to join.
export const assembleRecording = async (recording) => {
  const { files, bytes } = await contiguousParts(recording.id);
  if (files.length === 0) return { s3Key: null, parts: 0, bytes: 0 };

  const name = `session-${recording.session_id}-recording-${recording.id}.${extensionFor(recording.mime_type)}`;
  const localKey = localKeyFor(name);
  const joined = localPathOf(localKey);
  const out = fs.createWriteStream(joined);
  for (const file of files) {
    await pipeline(fs.createReadStream(file), out, { end: false });
  }
  await new Promise((resolve, reject) => out.end((/** @type {any} */ err) => (err ? reject(err) : resolve(undefined))));
  await remuxInPlace(joined);
  const size = (await fsp.stat(joined)).size;
  // Measured here, while the file is still on this disk: once it has gone to
  // S3, reading its header means fetching it back. null when unreadable.
  const durationSeconds = await probeDurationSeconds(joined);

  // To the bucket when S3 is configured, and then nothing of it stays here;
  // otherwise it is already where local media lives.
  const s3Key = await storeFile(localKey, { folder: "recordings", contentType: recording.mime_type.split(";")[0] });
  if (!isLocalKey(s3Key)) await fsp.rm(joined, { force: true });
  return { s3Key, parts: files.length, bytes: size || bytes, durationSeconds };
};
