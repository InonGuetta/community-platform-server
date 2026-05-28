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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const s3Configured = () => !!(
  process.env.AWS_REGION &&
  process.env.S3_BUCKET &&
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY
);
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

// Whisper wants either a Node ReadStream or a File-like object. For S3 the
// SDK gives us an async iterable, so we drain to a Buffer and wrap it with
// openai's toFile helper (the filename is what Whisper uses to detect format).
const loadAudio = async (s3Key) => {
  if (s3Key.startsWith("local/")) {
    const filename = s3Key.slice("local/".length);
    return fs.createReadStream(path.join(LOCAL_UPLOAD_DIR, filename));
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
  console.log(`[transcription] starting mediaId=${mediaId} s3Key=${s3Key}`);

  await pool.query(
    "UPDATE transcripts SET status='processing', updated_at=NOW() WHERE media_id=$1",
    [mediaId]
  );

  try {
    const audio = await loadAudio(s3Key);

    // verbose_json returns per-segment timestamps; language=he prevents
    // Whisper from guessing (and getting it wrong on short Hebrew clips).
    const transcription = await openai.audio.transcriptions.create({
      file: audio,
      model: "whisper-1",
      response_format: "verbose_json",
      language: "he",
    });

    const segments = transcription.segments || [];
    if (segments.length === 0) {
      throw new Error("Whisper returned no segments");
    }

    const chunkCount = await saveChunks(mediaId, segments);

    await pool.query(
      "UPDATE transcripts SET status='done', updated_at=NOW() WHERE media_id=$1",
      [mediaId]
    );

    const fullText = segments.map((s) => s.text).join(" ");
    await llmQueue.add({ mediaId, rawText: fullText });

    console.log(`[transcription] done mediaId=${mediaId} chunks=${chunkCount}`);
  } catch (err) {
    console.error(`[transcription] failed mediaId=${mediaId}:`, err.message);
    await pool.query(
      "UPDATE transcripts SET status='error', updated_at=NOW() WHERE media_id=$1",
      [mediaId]
    );
    throw err;
  }
});

console.log("Transcription worker started");
