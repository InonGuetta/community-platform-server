import "dotenv/config";
import { llmQueue } from "../llmQueue.js";
import OpenAI from "openai";
import { pool } from "../../db/pool.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `אתה מנתח תוכן מומחה. תקבל תמלול של הרצאה/שיעור בעברית.
החזר אובייקט JSON עם השדות הבאים בדיוק — כל הטקסט (summary, key_points) חייב להיות **בעברית**:
{
  "summary": "פסקה תמציתית של 3–5 משפטים המסכמת את התוכן העיקרי",
  "key_points": ["נקודה מרכזית 1", "נקודה מרכזית 2", "נקודה מרכזית 3"]
}
שמות השדות נשארים באנגלית (summary, key_points). רק הערכים בעברית.
החזר רק JSON תקין — בלי markdown, בלי הסברים, בלי \`\`\`.`;

llmQueue.process(async (job) => {
  const { mediaId, rawText } = job.data;
  const t0 = Date.now();
  console.log(`[WORKER:llm] ── job picked up jobId=${job.id} mediaId=${mediaId} textLen=${rawText.length}`);

  try {
    console.log(`[WORKER:llm] step 1/2 — calling GPT-4o`);
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: rawText },
      ],
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    console.log(`[WORKER:llm] step 1/2 ✓ GPT-4o returned summary=${parsed.summary?.length}ch keyPoints=${parsed.key_points?.length}`);

    // Chapters are no longer auto-generated. The transcript view shows a single
    // "subheadings by key points" block that the user produces on demand from
    // the key points below — so we only persist summary + key_points here.
    console.log(`[WORKER:llm] step 2/2 — updating transcripts row`);
    await pool.query(
      `UPDATE transcripts SET
        ai_summary=$1,
        ai_key_points=$2,
        updated_at=NOW()
       WHERE media_id=$3`,
      [
        parsed.summary,
        JSON.stringify(parsed.key_points),
        mediaId,
      ]
    );
    console.log(`[WORKER:llm] ── DONE mediaId=${mediaId} total=${Date.now() - t0}ms`);
  } catch (err) {
    console.error(`[WORKER:llm] ✗ FAILED mediaId=${mediaId} ${Date.now() - t0}ms — ${err.message}`);
    if (err.response?.data) console.error(`[WORKER:llm]   openai response:`, err.response.data);
    throw err;
  }
});

llmQueue.on("error", (err) => {
  console.error(`[WORKER:llm] queue error:`, err.message);
});

console.log("[WORKER:llm] LLM worker started, waiting for jobs...");
