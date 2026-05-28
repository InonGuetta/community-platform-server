import { pool } from "../db/pool.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";

const CHUNK_WORDS = 500;

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

export const saveChunks = async (mediaId, segments) => {
  const chunks = splitSegmentsToChunks(segments);
  await pool.query("DELETE FROM transcript_chunks WHERE media_id=$1", [mediaId]);

  for (const chunk of chunks) {
    await pool.query(
      `INSERT INTO transcript_chunks (media_id, chunk_index, start_time, end_time, content)
       VALUES ($1, $2, $3, $4, $5)`,
      [mediaId, chunk.chunk_index, chunk.start_time, chunk.end_time, chunk.content]
    );
  }
  return chunks.length;
};

export const getTranscriptByMediaId = async (mediaId) => {
  const [transcript, chunks] = await Promise.all([
    pool.query("SELECT * FROM transcripts WHERE media_id=$1", [mediaId]),
    pool.query(
      "SELECT * FROM transcript_chunks WHERE media_id=$1 ORDER BY chunk_index",
      [mediaId]
    ),
  ]);

  if (transcript.rows.length === 0) throw new Error("Transcript not found");

  return {
    ...transcript.rows[0],
    chunks: chunks.rows,
  };
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
  if (result.rows.length === 0) throw new Error("Transcript not found");
  return result.rows[0];
};

export const triggerPipeline = async (mediaId) => {
  console.log(`[BE:svc] triggerPipeline mediaId=${mediaId} → look up media`);
  const media = await pool.query(
    "SELECT id, s3_key, media_type FROM media_items WHERE id=$1",
    [mediaId]
  );
  if (media.rows.length === 0) {
    console.log(`[BE:svc] triggerPipeline mediaId=${mediaId} ✗ media not found in DB`);
    throw new Error("Media not found");
  }
  if (media.rows[0].media_type === "text") {
    console.log(`[BE:svc] triggerPipeline mediaId=${mediaId} ✗ text media — skipping`);
    throw new Error("Transcription is not available for text media");
  }
  console.log(`[BE:svc] triggerPipeline mediaId=${mediaId} found media type=${media.rows[0].media_type} s3Key=${media.rows[0].s3_key}`);

  await pool.query(
    `INSERT INTO transcripts (media_id, status) VALUES ($1, 'pending')
     ON CONFLICT (media_id) DO UPDATE SET status='pending', updated_at=NOW()`,
    [mediaId]
  );
  console.log(`[BE:svc] triggerPipeline mediaId=${mediaId} ✓ transcripts row set to 'pending'`);

  const job = await transcriptionQueue.add({ mediaId, s3Key: media.rows[0].s3_key });
  console.log(`[BE:svc] triggerPipeline mediaId=${mediaId} ✓ job queued id=${job.id}`);
  return { queued: true, mediaId, jobId: job.id };
};

export const searchTranscripts = async (query) => {
  const result = await pool.query(
    `SELECT
       c.media_id,
       c.chunk_index,
       c.start_time,
       c.end_time,
       c.content,
       m.title AS media_title,
       ts_headline('simple', c.content,
         plainto_tsquery('simple', $1),
         'MaxWords=20, MinWords=5') AS headline
     FROM transcript_chunks c
     JOIN media_items m ON c.media_id = m.id
     WHERE to_tsvector('simple', c.content) @@ plainto_tsquery('simple', $1)
     ORDER BY c.media_id, c.start_time
     LIMIT 30`,
    [query]
  );
  return result.rows;
};
