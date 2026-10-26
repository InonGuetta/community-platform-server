// @ts-check
import "dotenv/config";
import { pool } from "./pool.js";
import { textQuality, LOW_TEXT_QUALITY } from "../lib/textQuality.js";

// One-off: measure how readable the text of every book processed before the
// LLM worker started measuring it (migration 033). Run with:
//
//     npm run backfill:text-quality -- --dry     # reports what it would write
//     npm run backfill:text-quality              # writes
//
// Measured from the stored chunks, joined in order — the same text the worker
// measures at extraction, so no file is read and no OpenAI call is made. Only
// NULL values are written: a second run changes nothing, and a book the worker
// has measured since is left alone.

const DRY = process.argv.includes("--dry");

async function backfill() {
  const { rows: books } = await pool.query(
    `SELECT m.id, m.title
     FROM media_items m
     JOIN transcripts t ON t.media_id = m.id
     WHERE m.media_type = 'text' AND t.text_quality IS NULL
       AND EXISTS (SELECT 1 FROM transcript_chunks c WHERE c.media_id = m.id)
     ORDER BY m.id`
  );
  console.log(`${DRY ? "[dry run — nothing will be written] " : ""}${books.length} book(s) not yet measured.`);

  let written = 0;
  for (const { id, title } of books) {
    const { rows } = await pool.query(
      "SELECT content FROM transcript_chunks WHERE media_id = $1 ORDER BY chunk_index",
      [id]
    );
    const quality = textQuality(rows.map((r) => r.content).join("\n\n"));
    if (!DRY) {
      const { rowCount } = await pool.query(
        "UPDATE transcripts SET text_quality = $2 WHERE media_id = $1 AND text_quality IS NULL",
        [id, quality]
      );
      written += rowCount ?? 0;
    }
    const flag = quality !== null && quality < LOW_TEXT_QUALITY ? " — LOW: the page will warn" : "";
    console.log(`  ✓ media ${id} "${title}": ${quality ?? "?"}% readable${flag}`);
  }

  console.log(DRY ? "\nDry run — nothing written." : `\nDone. ${written} book(s) measured.`);
  await pool.end();
}

backfill().catch(async (err) => {
  console.error(`Backfill failed: ${err.message}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
