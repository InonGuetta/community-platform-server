// @ts-check
import "dotenv/config";
import { pool } from "./pool.js";
import { readMediaBuffer } from "../lib/storage.js";
import { extractDocumentText } from "../lib/textExtract.js";
import { pagesForStoredChunks } from "../services/transcripts/chunks.js";

// One-off: give a page number to every chunk of a PDF book that was processed
// before pages were recorded (migration 023). Run with:
//
//     npm run backfill:pages -- --dry     # reports what it would write
//     npm run backfill:pages              # writes
//
// Without a page, a passage of a book cannot be cited as "עמ' 47" and cannot be
// opened at its page — the "דיון עם AI" tab shows it as "קטע N", unclickable.
//
// ── Why not simply re-process the book ──────────────────────────────────────
//
// "הפק סיכום מחדש" does not re-extract a book that already has chunks (the LLM
// worker skips extraction to make retries cheap), and deleting the chunks to
// force it would throw away every embedding — which costs OpenAI money to
// rebuild — and cut every text bookmark loose from its passage. This writes one
// column and nothing else.
//
// ── Safe ────────────────────────────────────────────────────────────────────
//
// The original file is read and extracted again, and the result is compared
// with the stored chunks character for character (pagesForStoredChunks). A book
// whose text no longer matches — the extractor changed since it was processed —
// is reported and left alone: a page computed against different text is a
// wrong citation. Only NULL pages are written, so a second run changes nothing,
// and no OpenAI call is made.

const DRY = process.argv.includes("--dry");

const booksMissingPages = async () => {
  const { rows } = await pool.query(
    `SELECT m.id, m.title, m.s3_key
     FROM media_items m
     WHERE m.media_type = 'text'
       AND EXISTS (SELECT 1 FROM transcript_chunks c WHERE c.media_id = m.id AND c.page_number IS NULL)
     ORDER BY m.id`
  );
  return rows;
};

async function backfill() {
  const books = await booksMissingPages();
  console.log(`${DRY ? "[dry run — nothing will be written] " : ""}${books.length} book(s) have chunks without a page.`);

  let written = 0;
  for (const { id, title, s3_key: s3Key } of books) {
    if (!/\.pdf$/i.test(s3Key)) {
      console.log(`  - media ${id} "${title}": not a PDF — it has no pages, left alone`);
      continue;
    }

    let extracted;
    try {
      extracted = await extractDocumentText(await readMediaBuffer(s3Key), s3Key);
    } catch (err) {
      console.log(`  ✗ media ${id} "${title}": could not read or extract the file — ${err.message}`);
      continue;
    }

    const { rows: chunks } = await pool.query(
      `SELECT id, char_start, char_end, page_number, content
       FROM transcript_chunks WHERE media_id = $1 ORDER BY chunk_index`,
      [id]
    );
    const { aligned, mismatches, updates } = pagesForStoredChunks(chunks, extracted.text, extracted.pageOffsets);

    if (!aligned) {
      console.log(`  ✗ media ${id} "${title}": ${mismatches.length} of ${chunks.length} chunk(s) no longer match the file's text — left alone`);
      continue;
    }
    if (updates.length === 0) {
      console.log(`  ✗ media ${id} "${title}": the extractor could not derive page boundaries for this file — left alone`);
      continue;
    }

    const pages = updates.map((u) => u.page_number);
    const span = `pages ${Math.min(...pages)}–${Math.max(...pages)}`;
    if (!DRY) {
      // One statement per book, and only where the page is still NULL.
      const { rowCount } = await pool.query(
        `UPDATE transcript_chunks c SET page_number = u.page
         FROM unnest($1::int[], $2::int[]) AS u(id, page)
         WHERE c.id = u.id AND c.media_id = $3 AND c.page_number IS NULL`,
        [updates.map((u) => u.id), pages, id]
      );
      written += rowCount ?? 0;
    }
    console.log(`  ✓ media ${id} "${title}": ${updates.length} chunk(s), ${span}, all ${chunks.length} matching the file`);
  }

  console.log(DRY ? "\nDry run — nothing written." : `\nDone. ${written} chunk(s) given a page.`);
  await pool.end();
}

backfill().catch(async (err) => {
  console.error(`Backfill failed: ${err.message}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
