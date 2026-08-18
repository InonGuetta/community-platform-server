// @ts-check
import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { pipeline } from "stream/promises";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { transcriptionQueue } from "../transcriptionQueue.js";
import { llmQueue } from "../llmQueue.js";
import { pool } from "../../db/pool.js";
import { saveChunks, reconcileMissingTranscripts } from "../../services/servicesTranscripts.js";
import { embedChunksForMedia } from "../../services/servicesEmbeddings.js";
import { makeOpenAI } from "../../lib/openaiClient.js";
import { s3, s3Configured, LOCAL_UPLOAD_DIR } from "../../lib/storage.js";
import { logger } from "../../lib/logger.js";
import { env } from "../../lib/env.js";
import { installWorkerLifecycle, installQueueErrorLogging } from "./workerLifecycle.js";
import { parseSegmentStarts, assumedSegmentStarts } from "./segmentOffsets.js";

// Each audio segment is 10 minutes. At 16kHz mono 64kbps that's ~4.8MB —
// comfortably under Whisper's 25MB limit, with margin for VBR jitter.
const SEGMENT_SECONDS = 600;

// Everything this worker writes to disk goes under one directory of its own,
// rather than loose in the system temp directory.
//
// The startup sweep below is why. It deletes by NAME — anything that begins
// "transcribe-" or "src-" and is old enough — and the system temp directory is
// shared with every other process on the box. A prefix is not ownership, and a
// sweep that goes wrong there takes somebody else's files with it. Owning a
// directory makes the sweep's boundary a fact rather than a naming convention.
const WORK_DIR = path.join(os.tmpdir(), "community-platform-transcription");

ffmpeg.setFfmpegPath(ffmpegPath);

// Fewer retries on the audio path: ECONNRESET there is often a transient
// middlebox issue (AV/firewall/ISP DPI); the SDK still waits and retries.
const openai = makeOpenAI(3);

// Cleanup that must never itself become the reason a job fails. Declared here
// rather than beside their other callers below because resolveSourcePath needs
// them too.
const safeUnlink = (p) => fs.promises.unlink(p).catch(() => {});
const safeRmDir = (p) => fs.promises.rm(p, { recursive: true, force: true }).catch(() => {});

// Get a local filesystem path for the source media. Local uploads are already
// on disk; S3 objects are streamed down to a temp file first. Returns
// { path, isTemp } so the caller knows whether to delete it afterwards.
//
// STREAMED to disk, never buffered. This used to collect the whole object into
// an array of chunks and Buffer.concat it, which holds the entire file in the
// heap twice at the moment of the concat — for the multi-hour lectures this
// pipeline exists to serve, that is gigabytes, and Node's default heap limit
// kills the process before ffmpeg is ever reached. The failure mode was the
// worst kind: the worker dies without running its own catch, so nothing writes
// status='error' and the row sits at 'processing' forever while the page polls
// it for two hours. lib/storage.js already says buffering "would not be [fine]
// for media"; controllersMedia.resolveSeekablePath already streams. This is now
// the third place that agrees.
const resolveSourcePath = async (s3Key) => {
  if (s3Key.startsWith("local/")) {
    const filename = s3Key.slice("local/".length);
    return { path: path.join(LOCAL_UPLOAD_DIR, filename), isTemp: false };
  }
  if (!s3Configured()) {
    throw new Error(`S3 not configured but s3_key is remote: ${s3Key}`);
  }
  const { Body } = await s3.send(
    new GetObjectCommand({ Bucket: env.s3Bucket, Key: s3Key })
  );
  await fs.promises.mkdir(WORK_DIR, { recursive: true });
  const tmpPath = path.join(WORK_DIR, `src-${randomUUID()}${path.extname(s3Key)}`);
  try {
    await pipeline(/** @type {import("stream").Readable} */ (Body), fs.createWriteStream(tmpPath));
  } catch (err) {
    // A download cut off half-way leaves a partial file the caller never learns
    // about — it only receives a path on success, so nothing else would remove
    // it. Truncated media is also worse than none: ffmpeg would happily segment
    // whatever arrived and we would transcribe half a lecture and call it done.
    await safeUnlink(tmpPath);
    throw new Error(`could not download ${s3Key} from S3: ${err.message}`);
  }
  return { path: tmpPath, isTemp: true };
};

// Where each produced segment actually STARTS on the original recording.
//
// The offsets used to be computed as `index * SEGMENT_SECONDS`, and that number
// is not true. The segment muxer cuts on a frame boundary, never mid-frame, so
// every piece runs slightly past the requested length — and the excess is one
// directional error that accumulates down the file. A three-hour lecture ends up
// with its later timestamps sitting under a second early, which is small but is
// also pure invention: nothing measured it. Halve SEGMENT_SECONDS and the segment
// count doubles, and so does the error.
//
// So ffmpeg is asked to report the boundaries instead of being second-guessed.
// `-segment_list` with `-segment_list_type csv` makes the same pass that does the
// cutting write one line per piece — filename,start,end, in seconds — which is
// the authoritative answer, costs nothing, and needs no ffprobe binary (the
// bundled ffmpeg-static ships ffmpeg alone).
//
// Falling back to the old arithmetic rather than failing is deliberate: an
// ffmpeg build that writes the list differently must not kill a job that has
// already paid for its transcoding. The result is then no worse than before.
// The parsing itself lives in segmentOffsets.js, where it can be tested without
// starting this worker.
const readSegmentStarts = async (listPath, files) => {
  try {
    const starts = parseSegmentStarts(await fs.promises.readFile(listPath, "utf8"), files.length);
    if (starts) return starts;
    logger.warn(
      `[WORKER:transcription] segment list did not describe all ${files.length} segment(s) — ` +
      `falling back to assumed offsets`
    );
  } catch (err) {
    logger.warn(`[WORKER:transcription] could not read the segment list (${err.message}) — falling back to assumed offsets`);
  }
  return assumedSegmentStarts(files.length, SEGMENT_SECONDS);
};

// One ffmpeg pass does everything: strip video, downmix to 16kHz mono 64kbps
// MP3, AND split into SEGMENT_SECONDS-long pieces. A short file produces a
// single chunk000.mp3 and goes through the exact same loop — no special case.
// Returns the temp dir, the ordered chunk paths, and where each one begins.
const extractAndSegment = (inputPath) =>
  new Promise((resolve, reject) => {
    fs.promises
      .mkdir(WORK_DIR, { recursive: true })
      .then(() => fs.promises.mkdtemp(path.join(WORK_DIR, "transcribe-")))
      .then((dir) => {
        const pattern = path.join(dir, "chunk%03d.mp3");
        const listPath = path.join(dir, "segments.csv");
        ffmpeg(inputPath)
          .noVideo()
          .audioChannels(1)
          .audioFrequency(16000)
          .audioBitrate("64k")
          .outputOptions([
            "-f", "segment",
            "-segment_time", String(SEGMENT_SECONDS),
            "-segment_list", listPath,
            "-segment_list_type", "csv",
          ])
          .output(pattern)
          .on("end", async () => {
            const files = (await fs.promises.readdir(dir))
              .filter((f) => f.endsWith(".mp3"))
              .sort() // chunk000, chunk001, ... lexical sort is correct
              .map((f) => path.join(dir, f));
            resolve({ dir, files, starts: await readSegmentStarts(listPath, files) });
          })
          .on("error", (err) => {
            // ffmpeg failed after the temp dir was created — remove it here
            // since the caller never received `dir` to clean up itself.
            fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
            reject(new Error(`ffmpeg failed: ${err.message}`));
          })
          .run();
      })
      .catch(reject);
  });

// Transcribe one segment file. Returns Whisper's segments with their times
// shifted by `offsetSeconds` so they sit on the global timeline of the full
// recording (segment N starts at N * SEGMENT_SECONDS).
const transcribeSegment = async (filePath, offsetSeconds) => {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "whisper-1",
    response_format: "verbose_json",
    language: "he",
  });
  const segs = transcription.segments || [];
  return segs.map((s) => ({
    ...s,
    start: s.start + offsetSeconds,
    end: s.end + offsetSeconds,
  }));
};

transcriptionQueue.process(async (job) => {
  const { mediaId, s3Key } = job.data;
  const t0 = Date.now();
  logger.info(`[WORKER:transcription] ── job picked up jobId=${job.id} mediaId=${mediaId}`);

  await pool.query(
    "UPDATE transcripts SET status='processing', updated_at=NOW() WHERE media_id=$1",
    [mediaId]
  );
  logger.debug(`[WORKER:transcription] step 1/6 — status='processing' set in DB`);

  let source = null;
  let segmentDir = null;
  try {
    logger.debug(`[WORKER:transcription] step 2/6 — resolving source from ${s3Key.startsWith("local/") ? "local FS" : "S3"}`);
    source = await resolveSourcePath(s3Key);
    logger.debug(`[WORKER:transcription] step 2/6 ✓ source ready at ${source.path} (${Date.now() - t0}ms)`);

    logger.debug(`[WORKER:transcription] step 3/6 — extracting + segmenting audio (${SEGMENT_SECONDS}s chunks, 16kHz mono mp3)`);
    const tExtract = Date.now();
    const { dir, files, starts } = await extractAndSegment(source.path);
    segmentDir = dir;
    logger.debug(`[WORKER:transcription] step 3/6 ✓ produced ${files.length} segment(s) (${Date.now() - tExtract}ms)`);

    if (files.length === 0) throw new Error("ffmpeg produced no audio segments");

    logger.debug(`[WORKER:transcription] step 4/6 — transcribing ${files.length} segment(s) with Whisper (language=he)`);
    const tWhisper = Date.now();
    const allSegments = [];
    for (let i = 0; i < files.length; i++) {
      // Where ffmpeg says this piece begins, not where an even division assumed
      // it would — see readSegmentStarts.
      const offset = starts[i];
      const tSeg = Date.now();
      const sizeMb = ((await fs.promises.stat(files[i])).size / (1024 * 1024)).toFixed(2);
      logger.debug(`[WORKER:transcription]   segment ${i + 1}/${files.length} (${sizeMb}MB, offset=${offset}s) → Whisper`);
      const segs = await transcribeSegment(files[i], offset);
      allSegments.push(...segs);
      logger.debug(`[WORKER:transcription]   segment ${i + 1}/${files.length} ✓ ${segs.length} segments (${Date.now() - tSeg}ms)`);
    }
    logger.debug(`[WORKER:transcription] step 4/6 ✓ total ${allSegments.length} segments across ${files.length} chunk(s) (${Date.now() - tWhisper}ms)`);

    if (allSegments.length === 0) throw new Error("Whisper returned no segments");

    logger.debug(`[WORKER:transcription] step 5/6 — saving chunks to DB`);
    const chunkCount = await saveChunks(mediaId, allSegments);
    logger.debug(`[WORKER:transcription] step 5/6 ✓ ${chunkCount} DB chunks saved`);

    // 'analyzing', not 'done': the transcript itself is finished, but the
    // summary and key points are produced by the LLM job queued below. Marking
    // it done here ended the client's polling before that work existed, so the
    // summary panel stayed empty until someone reloaded the page. The LLM
    // worker moves it to 'done'.
    await pool.query(
      "UPDATE transcripts SET status='analyzing', updated_at=NOW() WHERE media_id=$1",
      [mediaId]
    );
    logger.debug(`[WORKER:transcription] step 6/6 ✓ status='analyzing' set in DB`);

    // Best-effort: embed the freshly-saved chunks for semantic search. This must
    // never fail the job — the transcript is already saved and status is past
    // missed embedding is recoverable later (the LLM headings path and the
    // backfill script both re-embed only the chunks WHERE embedding IS NULL).
    try {
      const embedded = await embedChunksForMedia(mediaId);
      logger.debug(`[WORKER:transcription] ✓ embedded ${embedded} chunk(s) for semantic search`);
    } catch (embedErr) {
      logger.error(`[WORKER:transcription] ⚠ embedding failed (non-fatal) mediaId=${mediaId} — ${embedErr.message}`);
    }

    // Only the id: the text is already in transcript_chunks, and putting a
    // multi-hour transcript in the job body meant Redis held a second copy of
    // every transcript indefinitely. The LLM worker reads it back from there.
    const llmJob = await llmQueue.add({ mediaId });
    logger.info(`[WORKER:transcription] ── DONE mediaId=${mediaId} total=${Date.now() - t0}ms — queued LLM job id=${llmJob.id}`);
  } catch (err) {
    logger.error(`[WORKER:transcription] ✗ FAILED mediaId=${mediaId} ${Date.now() - t0}ms — ${err.message}`);
    if (err.status) logger.error(`[WORKER:transcription]   http status:`, err.status);
    if (err.code) logger.error(`[WORKER:transcription]   err.code:`, err.code);
    if (err.cause) logger.error(`[WORKER:transcription]   cause:`, err.cause?.message || err.cause, "code:", err.cause?.code);
    if (err.response?.data) logger.error(`[WORKER:transcription]   openai response:`, err.response.data);
    // The stack, for the errors the fields above cannot describe. An OpenAI or
    // ffmpeg failure identifies itself in its message; a TypeError raised inside
    // saveChunks does not, and the message alone gives no way to find the line —
    // in a job that took an hour and cost real money to reach.
    if (err.stack) logger.debug(`[WORKER:transcription]   stack:`, err.stack);

    // .catch, not a bare await: the failures that get here are frequently
    // accompanied by an unreachable database (the pool is the thing most likely
    // to be down alongside everything else), and an UPDATE that throws inside a
    // catch block REPLACES the original error. The log would then report a
    // connection timeout for a job that actually died in ffmpeg, and Bull would
    // record the wrong reason, because `throw err` below never runs. This is the
    // shape llmWorker already uses.
    await pool.query(
      "UPDATE transcripts SET status='error', updated_at=NOW() WHERE media_id=$1",
      [mediaId]
    ).catch((dbErr) =>
      logger.error(`[WORKER:transcription]   could not set status='error': ${dbErr.message} — the row stays at 'processing'`)
    );
    throw err;
  } finally {
    // Clean up temp artifacts: the whole segment dir, and the source too if it
    // was downloaded from S3 (local uploads stay where they are).
    if (segmentDir) await safeRmDir(segmentDir);
    if (source?.isTemp) await safeUnlink(source.path);
  }
});

installQueueErrorLogging("transcription", transcriptionQueue);

// The per-job `finally` removes the segment directory AND the downloaded
// source, but that only runs if the process survives to reach it. A crash or a
// hard kill leaves both behind, on a disk that now also holds every upload.
// Sweep once at startup; the age cut-off is well past the longest plausible job
// so a concurrently-running worker's files are never touched.
//
// Everything swept lives under WORK_DIR, which this worker owns. It used to scan
// the whole system temp directory and delete anything NAMED "transcribe-*" or
// "src-*", which is a very different promise: those are ordinary prefixes, the
// directory is shared with every other process on the machine, and "src-" in
// particular is a name anything might pick. Nothing had gone wrong, but the sweep
// was one careless prefix away from deleting files it had no claim to.
//
// Both kinds still go, not just the segments: `src-` is the staged copy of the
// original upload and is by far the larger of the two — a whole lecture video
// against a few MB of 64kbps mp3 — so sweeping only `transcribe-` reclaimed the
// smaller half and left the reason the disk filled up sitting there. Inside a
// directory of our own, that is simply "everything old in here".
const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1000;

const sweepStaleTempDirs = async () => {
  try {
    const entries = await fs.promises.readdir(WORK_DIR);
    const cutoff = Date.now() - STALE_TEMP_AGE_MS;
    let removed = 0;
    for (const entry of entries) {
      const full = path.join(WORK_DIR, entry);
      try {
        const stat = await fs.promises.stat(full);
        if (stat.mtimeMs < cutoff) {
          await fs.promises.rm(full, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // Being read or removed by someone else — skip it.
      }
    }
    if (removed > 0) logger.info(`[WORKER:transcription] swept ${removed} stale temp file(s)/dir(s)`);
  } catch (err) {
    // ENOENT on the first ever run, before any job has created the directory.
    if (err.code === "ENOENT") return;
    logger.warn(`[WORKER:transcription] temp sweep skipped: ${err.message}`);
  }
};

sweepStaleTempDirs();

// Catch up on anything stranded while the queue was unreachable.
//
// On 'ready' rather than at startup, because the queue being *usable* is the
// thing that matters and that is not the same moment as the process starting:
// ioredis emits this on the first successful connection and again after every
// reconnect, so a Redis that was down at boot — or that disappeared for two days
// — still triggers the sweep the moment it comes back.
//
// Only the worker installs this. The API server holds a queue client too, and
// running it in both would have two processes racing to queue the same jobs.
const RECONCILE_DEBOUNCE_MS = 60_000;
let lastReconcileAt = 0;

transcriptionQueue.client.on("ready", async () => {
  // A flapping connection re-emits 'ready' repeatedly. The DB sweep behind this
  // is cheap, but the jobs it queues are not, so collapse bursts.
  if (Date.now() - lastReconcileAt < RECONCILE_DEBOUNCE_MS) return;
  lastReconcileAt = Date.now();

  try {
    const { found, queued, deferred } = await reconcileMissingTranscripts();
    if (found === 0) {
      logger.debug("[WORKER:transcription] reconcile — nothing stranded");
    } else {
      logger.info(
        `[WORKER:transcription] reconcile — queued ${queued.length} of ${found} stranded media` +
        `${deferred ? ` (${deferred} deferred to the next run)` : ""}`
      );
    }
  } catch (err) {
    // Never fatal: the worker's real job is processing the queue, and a failed
    // catch-up sweep must not stop it from doing that.
    logger.error(`[WORKER:transcription] reconcile failed (non-fatal) — ${err.message}`);
  }
});

installWorkerLifecycle("transcription", transcriptionQueue);

logger.info("[WORKER:transcription] Transcription worker started, waiting for jobs...");
