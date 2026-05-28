import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { toFile } from "openai/uploads";
import { transcriptionQueue } from "../transcriptionQueue.js";
import { llmQueue } from "../llmQueue.js";
import { pool } from "../../db/pool.js";
import { saveChunks } from "../../services/servicesTranscripts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_UPLOAD_DIR = path.join(__dirname, "../../uploads");

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

// Always send a Buffer wrapped with toFile — this produces a single multipart
// upload with a proper Content-Length, instead of chunked transfer encoding.
// Some Windows AV / ISP middleboxes drop chunked HTTPS uploads after ~30s,
// which is what was causing the read ECONNRESET.
const loadAudio = async (s3Key) => {
  if (s3Key.startsWith("local/")) {
    const filename = s3Key.slice("local/".length);
    const buffer = await fs.promises.readFile(path.join(LOCAL_UPLOAD_DIR, filename));
    return toFile(buffer, filename);
  }
  if (!s3Configured()) {
    throw new Error(`S3 not configured but s3_key is remote: ${s3Key}`);
  }
  const { Body } = await s3.send(
    new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: s3Key })
  );
  const chunks = [];
  for await (const chunk of Body) chunks.push(chunk);
  return toFile(Buffer.concat(chunks), s3Key.split("/").pop());
};

transcriptionQueue.process(async (job) => {
  const { mediaId, s3Key } = job.data;
  const t0 = Date.now();
  console.log(`[WORKER:transcription] ── job picked up jobId=${job.id} mediaId=${mediaId} s3Key=${s3Key}`);

  await pool.query(
    "UPDATE transcripts SET status='processing', updated_at=NOW() WHERE media_id=$1",
    [mediaId]
  );
  console.log(`[WORKER:transcription] step 1/5 — status='processing' set in DB`);

  try {
    console.log(`[WORKER:transcription] step 2/5 — loading audio from ${s3Key.startsWith("local/") ? "local FS" : "S3"}`);
    const audio = await loadAudio(s3Key);
    console.log(`[WORKER:transcription] step 2/5 ✓ audio loaded (${(Date.now() - t0)}ms)`);

    console.log(`[WORKER:transcription] step 3/5 — calling OpenAI Whisper (language=he)`);
    const tWhisper = Date.now();
    const transcription = await openai.audio.transcriptions.create({
      file: audio,
      model: "whisper-1",
      response_format: "verbose_json",
      language: "he",
    });
    const segments = transcription.segments || [];
    console.log(`[WORKER:transcription] step 3/5 ✓ Whisper returned ${segments.length} segments (${Date.now() - tWhisper}ms)`);

    if (segments.length === 0) {
      throw new Error("Whisper returned no segments");
    }

    console.log(`[WORKER:transcription] step 4/5 — saving chunks to DB`);
    const chunkCount = await saveChunks(mediaId, segments);
    console.log(`[WORKER:transcription] step 4/5 ✓ ${chunkCount} chunks saved`);

    await pool.query(
      "UPDATE transcripts SET status='done', updated_at=NOW() WHERE media_id=$1",
      [mediaId]
    );
    console.log(`[WORKER:transcription] step 5/5 ✓ status='done' set in DB`);

    const fullText = segments.map((s) => s.text).join(" ");
    const llmJob = await llmQueue.add({ mediaId, rawText: fullText });
    console.log(`[WORKER:transcription] ── DONE mediaId=${mediaId} total=${Date.now() - t0}ms — queued LLM job id=${llmJob.id}`);
  } catch (err) {
    console.error(`[WORKER:transcription] ✗ FAILED mediaId=${mediaId} ${(Date.now() - t0)}ms — ${err.message}`);
    if (err.status) console.error(`[WORKER:transcription]   http status:`, err.status);
    if (err.code) console.error(`[WORKER:transcription]   err.code:`, err.code);
    if (err.type) console.error(`[WORKER:transcription]   err.type:`, err.type);
    if (err.cause) console.error(`[WORKER:transcription]   cause:`, err.cause?.message || err.cause, "code:", err.cause?.code, "errno:", err.cause?.errno);
    if (err.response?.data) console.error(`[WORKER:transcription]   openai response:`, err.response.data);
    if (err.error) console.error(`[WORKER:transcription]   openai error:`, err.error);
    // Print env-relevant info so we can rule out wrong key / proxy quickly.
    console.error(`[WORKER:transcription]   diag: key=${process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.slice(0, 10) + "..." : "MISSING"} HTTP_PROXY=${process.env.HTTP_PROXY || "none"} HTTPS_PROXY=${process.env.HTTPS_PROXY || "none"}`);
    await pool.query(
      "UPDATE transcripts SET status='error', updated_at=NOW() WHERE media_id=$1",
      [mediaId]
    );
    throw err;
  }
});

transcriptionQueue.on("error", (err) => {
  console.error(`[WORKER:transcription] queue error:`, err.message);
});

console.log("[WORKER:transcription] Transcription worker started, waiting for jobs...");
