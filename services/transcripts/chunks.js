// @ts-check
// The transcript row and its chunks: writing them, reading them back.
//
// Everything else in this folder is a GPT stage or a queue concern; this is the
// only module that owns the storage shape, and it is what the two workers write
// through.
import { pool } from "../../db/pool.js";
import { chunkTextByParagraph } from "../../lib/textChunks.js";
import { canSeeMediaRow } from "../../lib/permissions.js";
import { logger } from "../../lib/logger.js";
import { notFound, ERROR_CODES } from "../../lib/AppError.js";

// Mirrored by TEXT_CHUNK_WORDS in lib/textChunks.js, which sizes document chunks
// to match — see its header. Exported so test/textChunks.test.js can assert the
// two are equal: this pair used to be held together by nothing but a comment,
// and drifting it degrades search quality without failing anything.
export const CHUNK_WORDS = 500;

// "".split(/\s+/) is [""], not [] — one empty string, which counts as a word.
//
// Whisper does emit silent segments, and each one was adding a phantom word to
// the running total and an extra space to the joined content. Chunks therefore
// closed slightly early and their text carried doubled spaces into the search
// index. Filtering here rather than at the call site keeps the "what counts as a
// word" answer in one place.
const wordsOf = (text) => String(text ?? "").trim().split(/\s+/).filter(Boolean);

const splitSegmentsToChunks = (segments) => {
  const chunks = [];
  let current = { words: [], start: 0, end: 0 };
  let index = 0;

  for (const seg of segments) {
    const words = wordsOf(seg.text);
    // A segment with no words is not a segment of the transcript. Skipped before
    // it can set a chunk's start time to a moment where nothing was said, or push
    // the end time past the last actual speech.
    if (words.length === 0) continue;

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
// 8 parameters each, and Postgres caps a statement at 65535 parameters. The
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
        const o = i * 8;
        values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8})`);
        params.push(
          mediaId,
          chunk.chunk_index,
          chunk.start_time ?? null,
          chunk.end_time ?? null,
          chunk.content,
          chunk.char_start ?? null,
          chunk.char_end ?? null,
          // NULL for audio and video, for a document with no pages, and for a
          // PDF whose boundaries could not be derived. See migration 023.
          chunk.page_number ?? null
        );
      });
      await client.query(
        `INSERT INTO transcript_chunks
           (media_id, chunk_index, start_time, end_time, content, char_start, char_end, page_number)
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

// Which page a character offset falls on.
//
// pageOffsets[i] is where page i+1 STARTS, ascending — so the page a position
// belongs to is the last one that begins at or before it. A linear scan from the
// end rather than a binary search: a book runs to hundreds of pages, not
// millions, and this is called once per chunk at write time.
//
// Returns null when there are no offsets at all, which is every .txt, every
// .docx, and any PDF whose boundaries could not be derived safely.
export const pageNumberFor = (pageOffsets, position) => {
  if (!Array.isArray(pageOffsets) || pageOffsets.length === 0) return null;
  for (let i = pageOffsets.length - 1; i >= 0; i -= 1) {
    if (position >= pageOffsets[i]) return i + 1;
  }
  // A position before the first page cannot happen — page one starts at 0 — but
  // answering "page 1" is the only sane response if it ever did.
  return 1;
};

// The document equivalent of saveChunks: paragraph-aligned chunks with
// character offsets instead of timestamps, and — for a PDF — the page each one
// begins on.
export const saveTextChunks = async (mediaId, text, pageOffsets = null) => {
  const chunks = chunkTextByParagraph(text).map((chunk) => ({
    ...chunk,
    // Stamped from the chunk's START. A chunk that straddles a page break
    // belongs to the page it begins on, which is where a reader looking for it
    // would turn first.
    page_number: pageNumberFor(pageOffsets, chunk.char_start ?? 0),
  }));
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
export const getTranscriptByMediaId = async (mediaId, scope = { courses: [], drafts: [] }) => {
  logger.debug(`[BE:svc] getTranscriptByMediaId mediaId=${mediaId} visible=${JSON.stringify(scope.courses)}`);

  // uploader_id rides along because the visibility rule now has two dimensions:
  // whose DRAFTS a caller may see is answered by who uploaded the item, and a
  // SELECT that omits it silently made every lecturer fail the ownership half.
  const media = await pool.query(
    "SELECT is_published, course_id, uploader_id FROM media_items WHERE id=$1",
    [mediaId]
  );
  // Same rule as the media reads and the search, from the same function. This is
  // the site the shared predicate exists for: a transcript has no visibility of
  // its own, it inherits the item's, so the two answering differently is the
  // definition of a leak.
  if (media.rows.length === 0 || !canSeeMediaRow(media.rows[0], scope.courses, scope.drafts)) {
    logger.debug(`[BE:svc] getTranscriptByMediaId mediaId=${mediaId} ✗ not visible`);
    throw notFound("Transcript not found", ERROR_CODES.TRANSCRIPT_NOT_FOUND);
  }

  const [transcript, chunks] = await Promise.all([
    pool.query("SELECT * FROM transcripts WHERE media_id=$1", [mediaId]),
    // Explicit columns (not SELECT *) so the embedding vector(1536) — added in
    // migration 010 — never ships to the client on every transcript load.
    pool.query(
      // char_start/char_end ride along for documents: they are the coordinate
      // space a bookmark in a book anchors to (migration 022), so the reader
      // cannot place one without them. Two ints per chunk — trivial next to the
      // content, and nothing like the vector(1536) this list exists to exclude.
      "SELECT id, media_id, chunk_index, start_time, end_time, char_start, char_end, page_number, content FROM transcript_chunks WHERE media_id=$1 ORDER BY chunk_index",
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

// ── Resolving a bookmark's anchor ───────────────────────────────────────────
//
// Two lookups, both answering "which chunk is this passage in, and what does it
// let me cite?". They live here rather than in servicesBookmarks because this
// module owns the storage shape of a chunk — a second place writing SELECTs
// against transcript_chunks is how the two learn different things about it.
//
// Both return only what an anchor needs: the id to store, the offsets to
// validate a range against, and the page to copy onto the bookmark. Never
// `content` — a chunk is ~500 words, and the caller is validating a position,
// not reading the book.
const ANCHOR_COLUMNS = "id, char_start, char_end, page_number";

/** The chunk with this id, but only if it belongs to this media item. */
export const getChunkForAnchor = async (mediaId, chunkId) => {
  const { rows } = await pool.query(
    `SELECT ${ANCHOR_COLUMNS} FROM transcript_chunks WHERE id=$1 AND media_id=$2`,
    [chunkId, mediaId]
  );
  return rows[0] ?? null;
};

/**
 * The chunk containing this character offset.
 *
 * `char_start IS NOT NULL` excludes audio and video chunks, whose offsets are
 * NULL — without it, `$2 BETWEEN NULL AND NULL` is simply never true, which
 * happens to be the right answer but only by accident. Saying it explicitly is
 * what keeps a recording's chunk from ever being considered a place in a book.
 *
 * LIMIT 1 because chunk ranges are adjacent and non-overlapping by construction
 * (chunkTextByParagraph slices a single string), so at most one can match; the
 * ORDER BY makes the answer deterministic rather than trusting that.
 */
export const getChunkContaining = async (mediaId, position) => {
  const { rows } = await pool.query(
    `SELECT ${ANCHOR_COLUMNS} FROM transcript_chunks
      WHERE media_id=$1
        AND char_start IS NOT NULL
        AND char_end IS NOT NULL
        AND $2 BETWEEN char_start AND char_end
      ORDER BY chunk_index
      LIMIT 1`,
    [mediaId, position]
  );
  return rows[0] ?? null;
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
