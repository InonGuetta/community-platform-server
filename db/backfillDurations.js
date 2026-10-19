// @ts-check
import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { pipeline } from "stream/promises";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { pool } from "./pool.js";
import { s3, s3Configured, LOCAL_UPLOAD_DIR } from "../lib/storage.js";
import { env } from "../lib/env.js";
import { probeDurationSeconds } from "../lib/mediaDuration.js";
import { setDurationIfMissing } from "../services/servicesMedia.js";

// One-off: give a length to every recording uploaded before lengths were
// measured. Run with:
//
//     npm run backfill:durations              # writes
//     npm run backfill:durations -- --dry     # reports what it would write
//
// media_items.duration_seconds existed from migration 002 and nothing wrote it
// until the upload started measuring (lib/mediaDuration.js), so every older
// audio and video row holds NULL — and the archive's length filter cannot place
// a lesson it has no length for.
//
// ── Where each length comes from, best first ────────────────────────────────
//
//   1. The file, read by the same ffmpeg header probe the upload uses. A local
//      upload is probed where it lies. One in S3 is fetched to a temporary file
//      first — ffmpeg has to seek to find the length in an MP4 whose index sits
//      at the end, which a piped stream cannot do — and deleted straight after.
//   2. The transcript, when the file cannot be read (gone from storage, or a
//      header ffmpeg cannot parse): the end of the last transcribed passage.
//      That is when the last WORDS end, so it can fall short of the recording by
//      a closing silence — reported as approximate, and still far closer than
//      no length, which is what the filter would otherwise have.
//
// ── Safe to run again ───────────────────────────────────────────────────────
//
// Every write goes through setDurationIfMissing, which only fills a NULL. A
// second run touches nothing the first one wrote, and a run cut short picks up
// where it stopped. Documents are never selected and never written.

const DRY = process.argv.includes("--dry");
const WORK_DIR = path.join(os.tmpdir(), "community-platform-durations");

const recordingsWithoutLength = async () => {
  const { rows } = await pool.query(
    `SELECT id, title, s3_key FROM media_items
     WHERE media_type <> 'text' AND duration_seconds IS NULL
     ORDER BY id`
  );
  return rows;
};

// When the last transcribed passage ends, or null if there is no transcript.
const transcriptEndSeconds = async (mediaId) => {
  const { rows } = await pool.query(
    "SELECT MAX(end_time) AS end_time FROM transcript_chunks WHERE media_id = $1",
    [mediaId]
  );
  const seconds = Number(rows[0]?.end_time);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : null;
};

// The file on disk, fetched from S3 if it has to be. `cleanup` removes only
// what this script created.
const localCopyOf = async (s3Key) => {
  if (s3Key.startsWith("local/")) {
    const filePath = path.join(LOCAL_UPLOAD_DIR, s3Key.slice("local/".length));
    if (!fs.existsSync(filePath)) return { filePath: null, why: "the file is no longer on disk", cleanup: async () => {} };
    return { filePath, why: null, cleanup: async () => {} };
  }
  if (!s3Configured()) {
    return { filePath: null, why: "it is in S3 and S3 is not configured here", cleanup: async () => {} };
  }
  await fs.promises.mkdir(WORK_DIR, { recursive: true });
  const tmp = path.join(WORK_DIR, `probe-${randomUUID()}${path.extname(s3Key)}`);
  const cleanup = () => fs.promises.rm(tmp, { force: true });
  try {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: env.s3Bucket, Key: s3Key }));
    // Same narrowing as lib/storage.js: on Node the SDK's Body is a Readable.
    await pipeline(/** @type {import("stream").Readable} */ (Body), fs.createWriteStream(tmp));
    return { filePath: tmp, why: null, cleanup };
  } catch (err) {
    await cleanup();
    return { filePath: null, why: `could not fetch it from S3 (${err.message})`, cleanup: async () => {} };
  }
};

const formatLength = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};

async function backfill() {
  const rows = await recordingsWithoutLength();
  console.log(
    `${DRY ? "[dry run — nothing will be written] " : ""}` +
    `${rows.length} recording(s) have no length.`
  );

  const fromFile = [];
  const fromTranscript = [];
  const unresolved = [];

  for (const { id, title, s3_key: s3Key } of rows) {
    const copy = await localCopyOf(s3Key);
    let seconds = null;
    let source = null;
    let why = copy.why;
    try {
      if (copy.filePath) {
        seconds = await probeDurationSeconds(copy.filePath);
        if (seconds !== null) source = "file";
        else why = "ffmpeg found no length in its header";
      }
    } finally {
      await copy.cleanup();
    }

    if (seconds === null) {
      seconds = await transcriptEndSeconds(id);
      if (seconds !== null) source = "transcript";
    }

    if (seconds === null) {
      unresolved.push({ id, title, why: `${why ?? "unknown"}, and there is no transcript to fall back on` });
      console.log(`  ✗ media ${id} "${title}": no length — ${unresolved.at(-1).why}`);
      continue;
    }

    const written = DRY ? true : await setDurationIfMissing(id, seconds);
    const label = source === "file" ? "from the file" : "from the transcript (approximate)";
    (source === "file" ? fromFile : fromTranscript).push(id);
    console.log(
      `  ${written ? "✓" : "-"} media ${id} "${title}": ${formatLength(seconds)} ${label}` +
      `${written ? "" : " — already set meanwhile, left alone"}`
    );
  }

  console.log(
    `\n${DRY ? "Would write" : "Done."} ${fromFile.length} from the file, ` +
    `${fromTranscript.length} from the transcript, ${unresolved.length} without a length.`
  );
  if (unresolved.length > 0) {
    console.log(`Without a length: media ${unresolved.map((u) => u.id).join(", ")}. ` +
      "They stay out of the length filter until the transcription worker can read them.");
  }
  await fs.promises.rm(WORK_DIR, { recursive: true, force: true }).catch(() => {});
  await pool.end();
}

backfill().catch(async (err) => {
  console.error(`Backfill failed: ${err.message}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
