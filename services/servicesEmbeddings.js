// @ts-check
import { pool } from "../db/pool.js";
import { makeOpenAI } from "../lib/openaiClient.js";
import { logger } from "../lib/logger.js";

// Same embedding model + dims as migration 010's vector(1536) column. Changing
// the model means changing the column dimension, so keep them in lockstep.
const EMBEDDING_MODEL = "text-embedding-3-small";

// OpenAI accepts an array of inputs per request; 100 is a safe batch that keeps
// each request well under the payload/token limits for chunk-sized texts.
const EMBED_BATCH = 100;

// How many embeddings are written per statement. See embedChunksForMedia: this
// bounds the size of the statement's text, not a parameter count. 100 keeps each
// one around 2MB and turns a 500-chunk book from 500 round trips into 5.
const UPDATE_BATCH = 100;

// 5 retries: embedding a long backfill shares the org's per-minute token budget
// with the rest of the pipeline. A 429 returns Retry-After; the SDK waits and
// retries so batches self-pace.
const openai = makeOpenAI(5);

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

// Pair each row id with ITS OWN vector, in batches of `size`.
//
// Pulled out as a pure function purely so it can be tested. The alignment
// between the two arrays is the whole correctness of the batched write and it is
// invisible when wrong: an off-by-one hands every chunk its neighbour's
// embedding, the UPDATE succeeds, and search quietly returns the wrong passages
// forever. Nothing above this — where `pool` is stubbed and OpenAI is never
// called — could catch that.
//
// Returns [ids[], literals[]] pairs, ready to be the two array parameters.
export const embeddingBatches = (rows, vectors, size) => {
  if (rows.length !== vectors.length) {
    throw new Error(
      `embeddingBatches: ${rows.length} rows but ${vectors.length} vectors`
    );
  }
  const batches = [];
  for (let offset = 0; offset < rows.length; offset += size) {
    const slice = rows.slice(offset, offset + size);
    batches.push([
      slice.map((r) => r.id),
      slice.map((_, i) => toVectorLiteral(vectors[offset + i])),
    ]);
  }
  return batches;
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
    logger.debug(`[BE:svc] embedChunksForMedia mediaId=${mediaId} — nothing to embed`);
    return 0;
  }
  logger.debug(`[BE:svc] embedChunksForMedia mediaId=${mediaId} — embedding ${rows.length} chunk(s)`);
  const vectors = await embedTexts(rows.map((r) => r.content));

  // Written in batches, not one UPDATE per chunk. A lecture is a few dozen
  // chunks and the round trips were invisible; a 250k-word book is ~500, and 500
  // sequential round trips to Supabase is minutes of doing nothing but waiting —
  // at the tail of a job that has already spent an hour and real money.
  //
  // UPDATE ... FROM unnest() sends one statement per batch and lets Postgres
  // join the ids to their vectors.
  //
  // Batched for PAYLOAD size, not for the parameter limit that bounds
  // writeChunks — this sends two array parameters however many rows it carries,
  // so 65535 is never in reach. What is in reach is the text: a vector literal
  // is 1536 floats, roughly 20KB, so an unbatched book would be a single ~10MB
  // statement. The batch also makes an interrupted run cheap, because every
  // completed batch stays embedded and this only ever selects rows WHERE
  // embedding IS NULL — a re-run resumes instead of re-buying what already
  // landed.
  for (const [ids, literals] of embeddingBatches(rows, vectors, UPDATE_BATCH)) {
    await pool.query(
      `UPDATE transcript_chunks AS c
          SET embedding = v.embedding::vector
         FROM unnest($1::int[], $2::text[]) AS v(id, embedding)
        WHERE c.id = v.id`,
      [ids, literals]
    );
  }
  logger.debug(`[BE:svc] embedChunksForMedia mediaId=${mediaId} ✓ ${rows.length} chunk(s) embedded`);
  return rows.length;
};
