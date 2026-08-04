// @ts-check
import path from "path";
import { fileURLToPath } from "url";
import { S3Client } from "@aws-sdk/client-s3";
import { env } from "./env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Where an s3_key of the form "local/<name>" resolves to on disk.
//
// Single-sourced deliberately: the upload writes here, the streaming and
// download controllers read from here, deleteMedia unlinks from here and the
// transcription worker opens files from here. Four copies of this path is
// exactly how that convention drifts and old media silently stops resolving.
export const LOCAL_UPLOAD_DIR = path.join(__dirname, "../uploads");

// Shared S3 client + the "is S3 configured?" check that controllers and the
// transcription worker both need. When S3 isn't configured the app falls back
// to local disk storage (s3_key prefixed "local/").
//
// This one reads process.env directly on purpose, unlike everywhere else in the
// app. It asks whether a value was SUPPLIED, and env.awsRegion carries a default
// — so going through it would report S3 as configured on a machine that has
// nothing set, and uploads would be attempted against a bucket that is undefined.
export const s3Configured = () => !!(
  process.env.AWS_REGION &&
  process.env.S3_BUCKET &&
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY
);

export const s3 = new S3Client({ region: env.awsRegion });

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
  if (s3Key.startsWith("local/")) {
    const { readFile } = await import("fs/promises");
    return readFile(path.join(LOCAL_UPLOAD_DIR, s3Key.slice("local/".length)));
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
