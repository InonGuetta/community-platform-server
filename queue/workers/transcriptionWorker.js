import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { transcriptionQueue } from "../transcriptionQueue.js";
import { llmQueue } from "../llmQueue.js";
import { pool } from "../../db/pool.js";
import { saveChunks } from "../../services/servicesTranscripts.js";
import { embedChunksForMedia } from "../../services/servicesEmbeddings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_UPLOAD_DIR = path.join(__dirname, "../../uploads");

// Each audio segment is 10 minutes. At 16kHz mono 64kbps that's ~4.8MB —
// comfortably under Whisper's 25MB limit, with margin for VBR jitter.
const SEGMENT_SECONDS = 600;

ffmpeg.setFfmpegPath(ffmpegPath);

// Explicit timeout + maxRetries: ECONNRESET on the audio endpoint is often a
// transient middlebox issue (AV/firewall/ISP DPI). With retries the SDK will
// wait and try again automatically.
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 5 * 60 * 1000,
  maxRetries: 3,
});

const s3Configured = () => !!(
  process.env.AWS_REGION &&
  process.env.S3_BUCKET &&
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY
);
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

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
  console.log(`[WORKER:transcription] ── job picked up jobId=${job.id} mediaId=${mediaId} s3Key=${s3Key}`);

  await pool.query(
    "UPDATE transcripts SET status='processing', updated_at=NOW() WHERE media_id=$1",
    [mediaId]
  );
  console.log(`[WORKER:transcription] step 1/6 — status='processing' set in DB`);

  let source = null;
  let segmentDir = null;
  try {
    console.log(`[WORKER:transcription] step 2/6 — resolving source from ${s3Key.startsWith("local/") ? "local FS" : "S3"}`);
    source = await resolveSourcePath(s3Key);
    console.log(`[WORKER:transcription] step 2/6 ✓ source ready at ${source.path} (${Date.now() - t0}ms)`);

    console.log(`[WORKER:transcription] step 3/6 — extracting + segmenting audio (${SEGMENT_SECONDS}s chunks, 16kHz mono mp3)`);
    const tExtract = Date.now();
    const { dir, files } = await extractAndSegment(source.path);
    segmentDir = dir;
    console.log(`[WORKER:transcription] step 3/6 ✓ produced ${files.length} segment(s) (${Date.now() - tExtract}ms)`);

    if (files.length === 0) throw new Error("ffmpeg produced no audio segments");

    console.log(`[WORKER:transcription] step 4/6 — transcribing ${files.length} segment(s) with Whisper (language=he)`);
    const tWhisper = Date.now();
    const allSegments = [];
    for (let i = 0; i < files.length; i++) {
      const offset = i * SEGMENT_SECONDS;
      const tSeg = Date.now();
      const sizeMb = ((await fs.promises.stat(files[i])).size / (1024 * 1024)).toFixed(2);
      console.log(`[WORKER:transcription]   segment ${i + 1}/${files.length} (${sizeMb}MB, offset=${offset}s) → Whisper`);
      const segs = await transcribeSegment(files[i], offset);
      allSegments.push(...segs);
      console.log(`[WORKER:transcription]   segment ${i + 1}/${files.length} ✓ ${segs.length} segments (${Date.now() - tSeg}ms)`);
    }
    console.log(`[WORKER:transcription] step 4/6 ✓ total ${allSegments.length} segments across ${files.length} chunk(s) (${Date.now() - tWhisper}ms)`);

    if (allSegments.length === 0) throw new Error("Whisper returned no segments");

    console.log(`[WORKER:transcription] step 5/6 — saving chunks to DB`);
    const chunkCount = await saveChunks(mediaId, allSegments);
    console.log(`[WORKER:transcription] step 5/6 ✓ ${chunkCount} DB chunks saved`);

    await pool.query(
      "UPDATE transcripts SET status='done', updated_at=NOW() WHERE media_id=$1",
      [mediaId]
    );
    console.log(`[WORKER:transcription] step 6/6 ✓ status='done' set in DB`);

    // Best-effort: embed the freshly-saved chunks for semantic search. This must
    // never fail the job — the transcript is already saved and status='done'. A
    // missed embedding is recoverable later (the LLM headings path and the
    // backfill script both re-embed only the chunks WHERE embedding IS NULL).
    try {
      const embedded = await embedChunksForMedia(mediaId);
      console.log(`[WORKER:transcription] ✓ embedded ${embedded} chunk(s) for semantic search`);
    } catch (embedErr) {
      console.error(`[WORKER:transcription] ⚠ embedding failed (non-fatal) mediaId=${mediaId} — ${embedErr.message}`);
    }

    const fullText = allSegments.map((s) => s.text).join(" ");
    const llmJob = await llmQueue.add({ mediaId, rawText: fullText });
    console.log(`[WORKER:transcription] ── DONE mediaId=${mediaId} total=${Date.now() - t0}ms — queued LLM job id=${llmJob.id}`);
  } catch (err) {
    console.error(`[WORKER:transcription] ✗ FAILED mediaId=${mediaId} ${Date.now() - t0}ms — ${err.message}`);
    if (err.status) console.error(`[WORKER:transcription]   http status:`, err.status);
    if (err.code) console.error(`[WORKER:transcription]   err.code:`, err.code);
    if (err.cause) console.error(`[WORKER:transcription]   cause:`, err.cause?.message || err.cause, "code:", err.cause?.code);
    if (err.response?.data) console.error(`[WORKER:transcription]   openai response:`, err.response.data);
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

transcriptionQueue.on("error", (err) => {
  console.error(`[WORKER:transcription] queue error:`, err.message);
});

console.log("[WORKER:transcription] Transcription worker started, waiting for jobs...");
