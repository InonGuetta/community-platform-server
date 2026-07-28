import path from "path";
import { fileURLToPath } from "url";
import { S3Client } from "@aws-sdk/client-s3";

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
export const s3Configured = () => !!(
  process.env.AWS_REGION &&
  process.env.S3_BUCKET &&
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY
);

export const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
