// @ts-check
// The transcript row and its chunks: writing them, reading them back.
//
// Everything else in this folder is a GPT stage or a queue concern; this is the
// only module that owns the storage shape, and it is what the two workers write
// through.
import { pool } from "../../db/pool.js";
import { chunkTextByParagraph } from "../../lib/textChunks.js";
import { logger } from "../../lib/logger.js";
import { notFound, ERROR_CODES } from "../../lib/AppError.js";

// Mirrored by TEXT_CHUNK_WORDS in lib/textChunks.js, which sizes document chunks
// to match — see its header. Exported so test/textChunks.test.js can assert the
// two are equal: this pair used to be held together by nothing but a comment,
// and drifting it degrades search quality without failing anything.
export const CHUNK_WORDS = 500;

const splitSegmentsToChunks = (segments) => {
  const chunks = [];
  let current = { words: [], start: 0, end: 0 };
  let index = 0;

  for (const seg of segments) {
    const words = seg.text.trim().split(/\s+/);
    if (current.words.length === 0) current.start = seg.start;

    current.words.push(...words);
    current.end = seg.end;

    if (current.words.length >= CHUNK_WORDS) {
      chunks.push({
        chunk_index: index++,
        start_time: Math.floor(current.start),
        end_time: Math.floor(current.end),
        content: current.words.join(" "),
      });
      current = { words: [], start: 0, end: 0 };
    }
  }

  if (current.words.length > 0) {
    chunks.push({
      chunk_index: index,
      start_time: Math.floor(current.start),
      end_time: Math.floor(current.end),
      content: current.words.join(" "),
    });
  }

  return chunks;
};

// Replace a media item's chunks atomically.
//
// DELETE + INSERT must be atomic: a failure mid-write previously left a media
// item with a partial set of chunks. Both run in one transaction, and every
// chunk goes in a single multi-row statement.
//
// One writer for both sources. Audio chunks carry start_time/end_time and no
// character offsets; document chunks carry char_start/char_end and no times.
// Each simply leaves the other's columns null — which is what migration 013
// made possible, and what keeps there from being two copies of this transaction
// drifting apart.
//
// Batched because a book is not a lecture: a 250k-word book is ~500 chunks at
// 7 parameters each, and Postgres caps a statement at 65535 parameters. The
// audio path never came close and so never needed this.
const INSERT_BATCH = 500;

const writeChunks = async (mediaId, chunks) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM transcript_chunks WHERE media_id=$1", [mediaId]);

    for (let offset = 0; offset < chunks.length; offset += INSERT_BATCH) {
      const batch = chunks.slice(offset, offset + INSERT_BATCH);
      const values = [];
      const params = [];
      batch.forEach((chunk, i) => {
        const o = i * 7;
        values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7})`);
        params.push(
          mediaId,
          chunk.chunk_index,
          chunk.start_time ?? null,
          chunk.end_time ?? null,
          chunk.content,
          chunk.char_start ?? null,
          chunk.char_end ?? null
        );
      });
      await client.query(
        `INSERT INTO transcript_chunks
           (media_id, chunk_index, start_time, end_time, content, char_start, char_end)
         VALUES ${values.join(", ")}`,
        params
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return chunks.length;
};

export const saveChunks = async (mediaId, segments) => {
  const chunks = splitSegmentsToChunks(segments);
  logger.debug(`[BE:svc] saveChunks mediaId=${mediaId} — ${segments.length} segments → ${chunks.length} chunks`);
  await writeChunks(mediaId, chunks);
  logger.debug(`[BE:svc] saveChunks mediaId=${mediaId} ✓ ${chunks.length} chunks written`);
  return chunks.length;
};

// The document equivalent of saveChunks: paragraph-aligned chunks with
// character offsets instead of timestamps.
export const saveTextChunks = async (mediaId, text) => {
  const chunks = chunkTextByParagraph(text);
  logger.debug(`[BE:svc] saveTextChunks mediaId=${mediaId} — ${text.length} chars → ${chunks.length} chunks`);
  await writeChunks(mediaId, chunks);
  logger.debug(`[BE:svc] saveTextChunks mediaId=${mediaId} ✓ ${chunks.length} chunks written`);
  return chunks.length;
};

// A transcript inherits the visibility of its media item. Without this check a
// student who knows (or guesses) a media id could read the full text of an
// unpublished draft straight from this endpoint, bypassing the is_published
// gate that /api/media enforces. Unknown media and hidden media return the same
// 404 so the endpoint doesn't reveal which ids exist.
export const getTranscriptByMediaId = async (mediaId, canSeeUnpublished = false) => {
  logger.debug(`[BE:svc] getTranscriptByMediaId mediaId=${mediaId} privileged=${canSeeUnpublished}`);

  const media = await pool.query("SELECT is_published FROM media_items WHERE id=$1", [mediaId]);
  if (media.rows.length === 0 || (!media.rows[0].is_published && !canSeeUnpublished)) {
    logger.debug(`[BE:svc] getTranscriptByMediaId mediaId=${mediaId} ✗ not visible`);
    throw notFound("Transcript not found", ERROR_CODES.TRANSCRIPT_NOT_FOUND);
  }

  const [transcript, chunks] = await Promise.all([
    pool.query("SELECT * FROM transcripts WHERE media_id=$1", [mediaId]),
    // Explicit columns (not SELECT *) so the embedding vector(1536) — added in
    // migration 010 — never ships to the client on every transcript load.
    pool.query(
      "SELECT id, media_id, chunk_index, start_time, end_time, content FROM transcript_chunks WHERE media_id=$1 ORDER BY chunk_index",
      [mediaId]
    ),
  ]);

  if (transcript.rows.length === 0) {
    logger.debug(`[BE:svc] getTranscriptByMediaId mediaId=${mediaId} ✗ not found`);
    throw notFound("Transcript not found", ERROR_CODES.TRANSCRIPT_NOT_FOUND);
  }

  logger.debug(`[BE:svc] getTranscriptByMediaId mediaId=${mediaId} ✓ status=${transcript.rows[0].status} chunks=${chunks.rows.length}`);
  return {
    ...transcript.rows[0],
    chunks: chunks.rows,
  };
};

// The transcript text, rebuilt from the saved chunks. Lets a job carry only a
// mediaId instead of the whole text, and means a retry reads the CURRENT state
// rather than a snapshot taken when the job was queued.
export const getTranscriptText = async (mediaId) => {
  const { rows } = await pool.query(
    "SELECT content FROM transcript_chunks WHERE media_id=$1 ORDER BY chunk_index",
    [mediaId]
  );
  return rows.map((r) => r.content).join("\n\n");
};

export const updateTranscript = async (mediaId, data) => {
  const { editedText, aiSummary, aiChapters, aiKeyPoints, status } = data;
  const result = await pool.query(
    `UPDATE transcripts SET
      edited_text   = COALESCE($1, edited_text),
      ai_summary    = COALESCE($2, ai_summary),
      ai_chapters   = COALESCE($3, ai_chapters),
      ai_key_points = COALESCE($4, ai_key_points),
      status        = COALESCE($5, status),
      updated_at    = NOW()
    WHERE media_id=$6 RETURNING *`,
    [
      editedText,
      aiSummary,
      aiChapters ? JSON.stringify(aiChapters) : null,
      aiKeyPoints ? JSON.stringify(aiKeyPoints) : null,
      status,
      mediaId,
    ]
  );
  if (result.rows.length === 0) throw notFound("Transcript not found", ERROR_CODES.TRANSCRIPT_NOT_FOUND);
  return result.rows[0];
};
