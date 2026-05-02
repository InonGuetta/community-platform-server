import "dotenv/config";
import { llmQueue } from "../llmQueue.js";
import OpenAI from "openai";
import { pool } from "../../db/pool.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are an expert content analyzer. Given a transcript, return a JSON object with exactly these fields:
{
  "summary": "A concise paragraph summarizing the main content",
  "chapters": [{ "title": "Chapter title", "start_time": 0, "end_time": 60 }],
  "key_points": ["Key point 1", "Key point 2", "Key point 3"]
}
Return only valid JSON, no markdown, no explanation.`;

llmQueue.process(async (job) => {
  const { mediaId, rawText } = job.data;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: rawText },
      ],
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(response.choices[0].message.content);

    await pool.query(
      `UPDATE transcripts SET
        ai_summary=$1,
        ai_chapters=$2,
        ai_key_points=$3,
        updated_at=NOW()
       WHERE media_id=$4`,
      [
        parsed.summary,
        JSON.stringify(parsed.chapters),
        JSON.stringify(parsed.key_points),
        mediaId,
      ]
    );
  } catch (err) {
    console.error(`LLM worker error for mediaId ${mediaId}:`, err.message);
    throw err;
  }
});

console.log("LLM worker started");
