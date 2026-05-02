import "dotenv/config";
import { transcriptionQueue } from "../transcriptionQueue.js";
import { llmQueue } from "../llmQueue.js";
import OpenAI from "openai";
import { pool } from "../../db/pool.js";
import { saveChunks } from "../../services/servicesTranscripts.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

transcriptionQueue.process(async (job) => {
  const { mediaId, s3Key } = job.data;

  await pool.query(
    "UPDATE transcripts SET status='processing', updated_at=NOW() WHERE media_id=$1",
    [mediaId]
  );

  try {
    // בפרודקשן: הורד מ-S3 ושלח ל-Whisper
    // const s3Client = new S3Client({ region: process.env.AWS_REGION });
    // const { Body } = await s3Client.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: s3Key }));
    // const transcription = await openai.audio.transcriptions.create({
    //   file: Body, model: "whisper-1", response_format: "verbose_json"
    // });

    // Mock לפיתוח — מחליף בתגובה אמיתית מ-Whisper
    const transcription = {
      segments: [
        { start: 0,   end: 30,  text: "שלום לכולם, היום נדבר על נושא חשוב." },
        { start: 30,  end: 90,  text: "הנושא הראשון שנעסוק בו הוא..." },
      ],
    };

    // שמירת קטעים לטבלת transcript_chunks
    const chunkCount = await saveChunks(mediaId, transcription.segments);

    await pool.query(
      "UPDATE transcripts SET status='done', updated_at=NOW() WHERE media_id=$1",
      [mediaId]
    );

    // שלח ל-LLM לסיכום
    const fullText = transcription.segments.map((s) => s.text).join(" ");
    await llmQueue.add({ mediaId, rawText: fullText });

    console.log(`Transcription done for mediaId=${mediaId}, chunks=${chunkCount}`);
  } catch (err) {
    await pool.query(
      "UPDATE transcripts SET status='error', updated_at=NOW() WHERE media_id=$1",
      [mediaId]
    );
    throw err;
  }
});

console.log("Transcription worker started");
