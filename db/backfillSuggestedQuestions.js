// @ts-check
import "dotenv/config";
import { pool } from "./pool.js";
import { generateSuggestedQuestions } from "../services/transcripts/questions.js";

// One-off: write suggested chat questions (PRD ASK-7, migration 045) for every
// lesson summarised before the worker started writing them. Run with:
//
//     npm run backfill:questions -- --dry     # lists the lessons, no OpenAI call
//     npm run backfill:questions              # writes
//
// One gpt-4o call per lesson, from its summary — about a quarter of a cent
// each, recorded in the admin's cost panel like any other call. Only lessons
// with a summary and no questions yet: a second run changes nothing, and a
// lesson the worker has done since is left alone. One at a time, so a large
// archive stays inside the per-minute token limit.

const DRY = process.argv.includes("--dry");

async function backfill() {
  const { rows: lessons } = await pool.query(
    `SELECT m.id, m.title
       FROM media_items m JOIN transcripts t ON t.media_id = m.id
      WHERE t.ai_summary IS NOT NULL AND t.suggested_questions IS NULL
      ORDER BY m.id`
  );
  console.log(`${DRY ? "[dry run — no OpenAI call, nothing written] " : ""}${lessons.length} lesson(s) without suggested questions.`);

  let written = 0;
  for (const { id, title } of lessons) {
    if (DRY) {
      console.log(`  · media ${id} "${title}"`);
      continue;
    }
    try {
      const questions = await generateSuggestedQuestions(id);
      if (questions?.length) written += 1;
      console.log(`  ✓ media ${id} "${title}": ${(questions ?? []).join(" | ") || "(none)"}`);
    } catch (err) {
      console.log(`  ✗ media ${id} "${title}": ${err.message}`);
    }
  }

  console.log(DRY ? "\nDry run — nothing written." : `\nDone. ${written} lesson(s) given questions.`);
  await pool.end();
}

backfill().catch(async (err) => {
  console.error(`Backfill failed: ${err.message}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
