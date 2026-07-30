import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
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
import { installWorkerLifecycle, installQueueErrorLogging } from "./workerLifecycle.js";

// Each audio segment is 10 minutes. At 16kHz mono 64kbps that's ~4.8MB —
// comfortably under Whisper's 25MB limit, with margin for VBR jitter.
const SEGMENT_SECONDS = 600;

ffmpeg.setFfmpegPath(ffmpegPath);

// Fewer retries on the audio path: ECONNRESET there is often a transient
// middlebox issue (AV/firewall/ISP DPI); the SDK still waits and retries.
const openai = makeOpenAI(3);

const collect = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

// Get a local filesystem path for the source media. Local uploads are already
// on disk; S3 objects are streamed down to a temp file first. Returns
// { path, isTemp } so the caller knows whether to delete it afterwards.
const resolveSourcePath = async (s3Key) => {
  if (s3Key.startsWith("local/")) {
    const filename = s3Key.slice("local/".length);
    return { path: path.join(LOCAL_UPLOAD_DIR, filename), isTemp: false };
  }
  if (!s3Configured()) {
    throw new Error(`S3 not configured but s3_key is remote: ${s3Key}`);
  }
  const { Body } = await s3.send(
    new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: s3Key })
  );
  const tmpPath = path.join(os.tmpdir(), `src-${randomUUID()}${path.extname(s3Key)}`);
  await fs.promises.writeFile(tmpPath, Buffer.concat(await collect(Body)));
  return { path: tmpPath, isTemp: true };
};

// One ffmpeg pass does everything: strip video, downmix to 16kHz mono 64kbps
// MP3, AND split into SEGMENT_SECONDS-long pieces. A short file produces a
// single chunk000.mp3 and goes through the exact same loop — no special case.
// Returns the temp dir + the ordered list of chunk file paths.
const extractAndSegment = (inputPath) =>
  new Promise((resolve, reject) => {
    fs.promises
      .mkdtemp(path.join(os.tmpdir(), "transcribe-"))
      .then((dir) => {
        const pattern = path.join(dir, "chunk%03d.mp3");
        ffmpeg(inputPath)
          .noVideo()
          .audioChannels(1)
          .audioFrequency(16000)
          .audioBitrate("64k")
          .outputOptions(["-f", "segment", "-segment_time", String(SEGMENT_SECONDS)])
          .output(pattern)
          .on("end", async () => {
            const files = (await fs.promises.readdir(dir))
              .filter((f) => f.endsWith(".mp3"))
              .sort() // chunk000, chunk001, ... lexical sort is correct
              .map((f) => path.join(dir, f));
            resolve({ dir, files });
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

const safeUnlink = (p) => fs.promises.unlink(p).catch(() => {});
const safeRmDir = (p) => fs.promises.rm(p, { recursive: true, force: true }).catch(() => {});

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
    const { dir, files } = await extractAndSegment(source.path);
    segmentDir = dir;
    logger.debug(`[WORKER:transcription] step 3/6 ✓ produced ${files.length} segment(s) (${Date.now() - tExtract}ms)`);

    if (files.length === 0) throw new Error("ffmpeg produced no audio segments");

    logger.debug(`[WORKER:transcription] step 4/6 — transcribing ${files.length} segment(s) with Whisper (language=he)`);
    const tWhisper = Date.now();
    const allSegments = [];
    for (let i = 0; i < files.length; i++) {
      const offset = i * SEGMENT_SECONDS;
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
    await pool.query(
      "UPDATE transcripts SET status='error', updated_at=NOW() WHERE media_id=$1",
      [mediaId]
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

// The per-job `finally` removes the segment directory, but that only runs if
// the process survives to reach it. A crash or a hard kill leaves the segments
// behind — a few MB per orphaned run, on a disk that now also holds every
// upload. Sweep once at startup; the age cut-off is well past the longest
// plausible job so a concurrently-running worker's directory is never touched.
const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1000;

const sweepStaleTempDirs = async () => {
  const tmp = os.tmpdir();
  try {
    const entries = await fs.promises.readdir(tmp);
    const cutoff = Date.now() - STALE_TEMP_AGE_MS;
    let removed = 0;
    for (const entry of entries.filter((e) => e.startsWith("transcribe-"))) {
      const full = path.join(tmp, entry);
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
    if (removed > 0) logger.info(`[WORKER:transcription] swept ${removed} stale temp dir(s)`);
  } catch (err) {
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
