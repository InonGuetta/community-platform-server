import { S3Client } from "@aws-sdk/client-s3";

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
