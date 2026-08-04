import "dotenv/config";
import fs from "fs";
import path from "path";
import { Upload } from "@aws-sdk/lib-storage";
import { pool } from "./pool.js";
import { s3, s3Configured, LOCAL_UPLOAD_DIR } from "../lib/storage.js";
import { getMimeType } from "../lib/mediaFormats.js";
import { env } from "../lib/env.js";

// Moves media that predates S3 out of the local uploads directory.
//
// Configuring S3 only affects NEW uploads: the storage location is recorded per
// row, as a "local/" or "uploads/" prefix on s3_key, and nothing rewrites the
// old rows. So a library uploaded before S3 was set up stays on one machine's
// disk indefinitely — which is the one thing here that cannot be regenerated.
// Transcripts can be re-run; a lost recording is lost.
//
//   npm run migrate:uploads-to-s3 -- --dry            preview
//   npm run migrate:uploads-to-s3                     copy, keep the local files
//   npm run migrate:uploads-to-s3 -- --delete-local   copy, then remove them
//
// Safe to re-run: it only looks at rows still marked local, and each file is
// committed to the database individually, so an interrupted run resumes.

const dryRun = process.argv.includes("--dry");
const deleteLocal = process.argv.includes("--delete-local");

const uploadOne = async (filename, filePath) => {
  const key = `uploads/${filename}`;
  await new Upload({
    client: s3,
    params: {
      Bucket: env.s3Bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: getMimeType(filename),
    },
  }).done();
  return key;
};

const run = async () => {
  if (!s3Configured()) {
    console.error(
      "S3 is not configured — nothing to migrate to.\n" +
      "Set AWS_REGION, S3_BUCKET, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY first."
    );
    process.exitCode = 1;
    return;
  }

  const { rows } = await pool.query(
    "SELECT id, title, s3_key FROM media_items WHERE s3_key LIKE 'local/%' ORDER BY id"
  );

  if (rows.length === 0) {
    console.log("No media is still stored locally.");
    return;
  }

  console.log(`${rows.length} media item(s) still on local disk${dryRun ? " (dry run)" : ""}:\n`);

  let moved = 0;
  let missing = 0;
  let failed = 0;

  for (const item of rows) {
    const filename = item.s3_key.slice("local/".length);
    const filePath = path.join(LOCAL_UPLOAD_DIR, filename);
    const label = `#${item.id} ${item.title || "(untitled)"}`;

    if (!fs.existsSync(filePath)) {
      // The row already points at nothing. Leaving it untouched keeps that
      // visible rather than rewriting it to an S3 key that is equally absent.
      console.log(`  ✗ ${label} — file missing from disk (${filename}), row left alone`);
      missing++;
      continue;
    }

    const sizeMb = (fs.statSync(filePath).size / 1048576).toFixed(1);
    if (dryRun) {
      console.log(`  → ${label} — would upload ${filename} (${sizeMb}MB)`);
      continue;
    }

    try {
      const key = await uploadOne(filename, filePath);
      // Only after the upload resolves, so an interrupted run never leaves a
      // row pointing at an object that was never finished.
      await pool.query("UPDATE media_items SET s3_key=$1 WHERE id=$2", [key, item.id]);
      if (deleteLocal) await fs.promises.unlink(filePath).catch(() => {});
      console.log(`  ✓ ${label} — ${sizeMb}MB → ${key}${deleteLocal ? " (local copy removed)" : ""}`);
      moved++;
    } catch (err) {
      console.error(`  ✗ ${label} — ${err.message}`);
      failed++;
    }
  }

  if (dryRun) {
    console.log(`\nDry run: nothing was uploaded or changed.`);
    return;
  }

  console.log(`\n${moved} moved, ${missing} missing, ${failed} failed.`);
  if (moved > 0 && !deleteLocal) {
    console.log("Local copies were kept. Re-run with --delete-local once you have verified playback.");
  }
  if (failed > 0) process.exitCode = 1;
};

run()
  .catch((err) => {
    console.error("Migration failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
