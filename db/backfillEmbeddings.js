import "dotenv/config";
import { pool } from "./pool.js";
import { embedChunksForMedia } from "../services/servicesEmbeddings.js";

// One-off: embed all existing transcript_chunks that predate the embedding
// column (migration 010). Idempotent — embedChunksForMedia only touches chunks
// WHERE embedding IS NULL, so re-running it after a partial failure just picks
// up where it left off. Run with: npm run backfill:embeddings
async function backfill() {
  const { rows } = await pool.query(
    "SELECT DISTINCT media_id FROM transcript_chunks WHERE embedding IS NULL ORDER BY media_id"
  );
  console.log(`Backfilling embeddings for ${rows.length} media item(s) with un-embedded chunks...`);

  let totalChunks = 0;
  let failed = 0;
  for (const { media_id } of rows) {
    try {
      const n = await embedChunksForMedia(media_id);
      totalChunks += n;
      console.log(`  ✓ media ${media_id}: ${n} chunk(s) embedded`);
    } catch (err) {
      failed++;
      console.error(`  ✗ media ${media_id}: FAILED — ${err.message}`);
    }
  }

  console.log(`Done. ${totalChunks} chunk(s) embedded across ${rows.length - failed} media item(s); ${failed} failed.`);
  await pool.end();
}

backfill();
