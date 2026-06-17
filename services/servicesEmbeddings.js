import OpenAI from "openai";
import { pool } from "../db/pool.js";

// Same embedding model + dims as migration 010's vector(1536) column. Changing
// the model means changing the column dimension, so keep them in lockstep.
const EMBEDDING_MODEL = "text-embedding-3-small";

// OpenAI accepts an array of inputs per request; 100 is a safe batch that keeps
// each request well under the payload/token limits for chunk-sized texts.
const EMBED_BATCH = 100;

// 5 retries: embedding a long backfill shares the org's per-minute token budget
// with the rest of the pipeline. A 429 returns Retry-After; the SDK waits and
// retries so batches self-pace.
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 5 * 60 * 1000,
  maxRetries: 5,
});

// pgvector accepts a vector literal as the text "[f1,f2,...]" cast with ::vector.
export const toVectorLiteral = (arr) => `[${arr.join(",")}]`;

// Embed an array of texts, returning an array of float[] in the same order.
// Batches of EMBED_BATCH; OpenAI may return data out of order, so we sort by
// the response index before mapping back onto the inputs.
export const embedTexts = async (texts) => {
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: batch });
    const sorted = [...res.data].sort((a, b) => a.index - b.index);
    out.push(...sorted.map((d) => d.embedding));
  }
  return out;
};

// Embed a single query string → float[] for the semantic/hybrid search.
export const embedQuery = async (query) => {
  const [vec] = await embedTexts([query]);
  return vec;
};

// Embed the chunks of one media item that don't yet have an embedding. Safe to
// re-run: only rows WHERE embedding IS NULL are touched, so the transcription
// worker (best-effort) and the backfill script never double-charge. Returns the
// number of chunks embedded.
export const embedChunksForMedia = async (mediaId) => {
  const { rows } = await pool.query(
    "SELECT id, content FROM transcript_chunks WHERE media_id=$1 AND embedding IS NULL ORDER BY chunk_index",
    [mediaId]
  );
  if (rows.length === 0) {
    console.log(`[BE:svc] embedChunksForMedia mediaId=${mediaId} — nothing to embed`);
    return 0;
  }
  console.log(`[BE:svc] embedChunksForMedia mediaId=${mediaId} — embedding ${rows.length} chunk(s)`);
  const vectors = await embedTexts(rows.map((r) => r.content));
  for (let i = 0; i < rows.length; i++) {
    await pool.query(
      "UPDATE transcript_chunks SET embedding=$1::vector WHERE id=$2",
      [toVectorLiteral(vectors[i]), rows[i].id]
    );
  }
  console.log(`[BE:svc] embedChunksForMedia mediaId=${mediaId} ✓ ${rows.length} chunk(s) embedded`);
  return rows.length;
};
