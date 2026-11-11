// @ts-check
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { env } from "./env.js";
import { getMimeType } from "./mediaFormats.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Where an s3_key of the form "local/<name>" resolves to on disk.
//
// Single-sourced deliberately: the upload writes here, the streaming and
// download controllers read from here, deleteMedia unlinks from here and the
// transcription worker opens files from here. Four copies of this path is
// exactly how that convention drifts and old media silently stops resolving.
export const LOCAL_UPLOAD_DIR = path.join(__dirname, "../uploads");

// ── Where a stored object lives: the s3_key ────────────────────────────────
//
// media_items.s3_key (and a session recording's) names the object wherever it
// is. A key that starts "local/" is a file in LOCAL_UPLOAD_DIR — every upload
// made while S3 was not configured, and every recording joined on this machine;
// any other key ("uploads/…", "recordings/…") is an object in the S3 bucket.
//
// The prefix is a convention stored in thousands of rows and read in a dozen
// places, so it is spelled out HERE and nowhere else (test/storageKeys.test.js
// fails on "local/" in any other server module). Ask through these.

// Exported for the one SQL query that has to select by it
// (db/migrateUploadsToS3.js: `s3_key LIKE 'local/%'`).
export const LOCAL_KEY_PREFIX = "local/";

/** Whether a key names a file on this machine's disk rather than an S3 object. */
export const isLocalKey = (key) => typeof key === "string" && key.startsWith(LOCAL_KEY_PREFIX);

/** The key for a file saved in LOCAL_UPLOAD_DIR under `name`. */
export const localKeyFor = (name) => `${LOCAL_KEY_PREFIX}${name}`;

/** A local key's file name inside LOCAL_UPLOAD_DIR. */
export const localNameOf = (key) => key.slice(LOCAL_KEY_PREFIX.length);

/** The absolute path of a local key's file. */
export const localPathOf = (key) => path.join(LOCAL_UPLOAD_DIR, localNameOf(key));

/**
 * Delete the stored object a key names, wherever it lives. Rejects with what
 * the disk or S3 reported — each caller decides whether that is worth a
 * warning, since by then the row it belonged to is usually already gone.
 *
 * `missingOk` is for cleanup that may run twice: a local file already gone is
 * then not an error. (Deleting an S3 key that does not exist never is.)
 *
 * @param {string} key
 * @param {{ missingOk?: boolean }} [options]
 */
export const removeStored = async (key, { missingOk = false } = {}) => {
  if (isLocalKey(key)) {
    await (missingOk ? fs.promises.rm(localPathOf(key), { force: true }) : fs.promises.unlink(localPathOf(key)));
    return;
  }
  await s3.send(new DeleteObjectCommand({ Bucket: env.s3Bucket, Key: key }));
};

// Shared S3 client + the "is S3 configured?" check that controllers and the
// transcription worker both need. When S3 isn't configured the app falls back
// to local disk storage (s3_key prefixed "local/").
//
// Whether the four values were SUPPLIED — env.s3Configured asks the raw values,
// not the getters with defaults; see the note there.
export const s3Configured = () => env.s3Configured;

export const s3 = new S3Client({ region: env.awsRegion });

/**
 * Store a file that is already in LOCAL_UPLOAD_DIR, named by its local key:
 * into the bucket as "<folder>/<name>" when S3 is configured, or left where it
 * is when it is not. Resolves to the key the row should hold — the bucket key,
 * or `key` itself.
 *
 * Streamed from disk, never held in memory: a recording can be gigabytes.
 *
 * The local copy stays either way. When it may go is the caller's call: an
 * upload keeps it until its row exists, a joined recording drops it at once, a
 * migration only once the row points at the bucket copy.
 *
 * @param {string} key  a local key (localKeyFor)
 * @param {{ folder: "uploads" | "recordings", contentType?: string }} options
 *   folder — "uploads" for media uploaded through the API, "recordings" for a
 *   live session's recording. contentType defaults to what the extension says.
 */
export const storeFile = async (key, { folder, contentType = getMimeType(key) }) => {
  if (!s3Configured()) return key;
  const bucketKey = `${folder}/${localNameOf(key)}`;
  await new Upload({
    client: s3,
    params: {
      Bucket: env.s3Bucket,
      Key: bucketKey,
      Body: fs.createReadStream(localPathOf(key)),
      ContentType: contentType,
    },
  }).done();
  return bucketKey;
};

// Read a stored media object into memory, wherever it lives.
//
// Deliberately buffer-returning and deliberately NOT shared with the
// transcription worker's resolveSourcePath, which returns a temp *file path*
// because ffmpeg needs one on disk. Documents are parsed from a Buffer, so
// routing them through a temp file would add a write, a read and a cleanup path
// for nothing. The small duplication of the "local/ vs S3" branch is the price
// of leaving the audio pipeline completely untouched.
//
// Buffering the whole object is fine at document sizes (a large PDF is tens of
// MB) but would not be for media — which is precisely why this is not used
// there.
export const readMediaBuffer = async (s3Key) => {
  if (isLocalKey(s3Key)) {
    const { readFile } = await import("fs/promises");
    return readFile(localPathOf(s3Key));
  }
  if (!s3Configured()) {
    throw new Error(`S3 not configured but s3_key is remote: ${s3Key}`);
  }
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { Body } = await s3.send(
    new GetObjectCommand({ Bucket: env.s3Bucket, Key: s3Key })
  );
  // The SDK types Body as a union covering every runtime it supports — a Blob
  // and a web ReadableStream in the browser, a Node Readable here — and only the
  // last of those can be iterated with `for await`. On Node it is always the
  // Readable, so the narrowing is correct; stating it makes the assumption
  // explicit rather than leaving it as an error the checker reports forever.
  const stream = /** @type {import("stream").Readable} */ (Body);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};
