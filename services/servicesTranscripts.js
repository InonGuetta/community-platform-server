import OpenAI from "openai";
import { pool } from "../db/pool.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";

const CHUNK_WORDS = 500;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 5 * 60 * 1000,
  maxRetries: 3,
});

// Yiddish-accented Hebrew confuses Whisper (e.g. "תורה"→"תוירו",
// "בית יוסף"→"בסייסף"). This prompt asks GPT to restore standard Hebrew
// using context, without adding/removing content.
const FIX_HEBREW_PROMPT = `שים לב כי התמלול כאן הוא של עברית אך הדובר הוא דובר עם הגייה של דובר יידיש, ולכן יש מילים שתומללו באופן לא מובן — למשל המילה "תורה" תומללה כ"תוירו", או "בית יוסף" כ"בסייסף", וכדומה.
התפקיד שלך הוא לקבל את הטקסט ולתקן אותו לעברית תקנית — כלומר למה שהכי סביר שזו המילה שנאמרה, בהתחשב בהקשר.
אל תוסיף, תשמיט או תסכם תוכן — רק תקן את האיות והמילים המשובשות. שמור על מבנה הפסקאות. החזר רק את הטקסט המתוקן, בלי הקדמות.`;

// Correct in word-batches so each GPT response stays within output token
// limits (a 3-hour lecture is ~27k words, far past one response). Each batch
// carries enough local context to disambiguate the Yiddish-isms.
const FIX_BATCH_WORDS = 2500;

const correctTextBatch = async (text) => {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: FIX_HEBREW_PROMPT },
      { role: "user", content: text },
    ],
  });
  return response.choices[0].message.content.trim();
};

export const fixHebrewTranscript = async (mediaId) => {
  console.log(`[BE:svc] fixHebrewTranscript mediaId=${mediaId}`);
  const existing = await pool.query("SELECT edited_text FROM transcripts WHERE media_id=$1", [mediaId]);
  if (existing.rows.length === 0) throw new Error("Transcript not found");

  const chunks = await pool.query(
    "SELECT content FROM transcript_chunks WHERE media_id=$1 ORDER BY chunk_index",
    [mediaId]
  );
  const sourceText = existing.rows[0].edited_text || chunks.rows.map((r) => r.content).join("\n\n");
  if (!sourceText.trim()) throw new Error("No transcript text to correct");

  const words = sourceText.split(/\s+/);
  const batches = [];
  for (let i = 0; i < words.length; i += FIX_BATCH_WORDS) {
    batches.push(words.slice(i, i + FIX_BATCH_WORDS).join(" "));
  }
  console.log(`[BE:svc] fixHebrewTranscript mediaId=${mediaId} — ${words.length} words in ${batches.length} batch(es)`);

  const corrected = [];
  for (let i = 0; i < batches.length; i++) {
    console.log(`[BE:svc] fixHebrewTranscript batch ${i + 1}/${batches.length} → GPT-4o`);
    corrected.push(await correctTextBatch(batches[i]));
  }
  const correctedText = corrected.join("\n\n");

  const result = await pool.query(
    "UPDATE transcripts SET edited_text=$1, updated_at=NOW() WHERE media_id=$2 RETURNING *",
    [correctedText, mediaId]
  );
  console.log(`[BE:svc] fixHebrewTranscript mediaId=${mediaId} ✓ saved ${correctedText.length} chars`);
  return result.rows[0];
};

// "Subheadings by key points": take the key points already produced by the LLM
// worker and place each one on the transcript timeline. We give GPT the key
// points plus a trimmed, time-stamped view of the chunks (first words of each
// are enough to locate the topic) and ask which start_time each point belongs
// to. Output is a clickable heading list, ordered by time.
const HEADINGS_PROMPT = `אתה מקבל (1) רשימת "נקודות מפתח" של שיעור בעברית, ו-(2) קטעי התמלול עם חותמת הזמן (start_time בשניות) של כל קטע.
לכל נקודת מפתח, מצא את חותמת הזמן (start_time) של הקטע שבו הנושא הזה מתחיל להידון.
החזר JSON תקין בלבד במבנה: { "headings": [{ "title": "נקודת המפתח כפי שהיא", "start_time": 123 }] }
כללים: השתמש בכל נקודות המפתח שקיבלת, אחת לכל אחת. start_time חייב להיות אחד מהזמנים שניתנו לך. מיין את הרשימה לפי start_time עולה. אל תמציא נקודות חדשות ואל תשנה את ניסוח נקודות המפתח. בלי markdown, בלי הסברים.`;

const HEADING_PREVIEW_WORDS = 120;

export const generateKeyPointHeadings = async (mediaId) => {
  console.log(`[BE:svc] generateKeyPointHeadings mediaId=${mediaId}`);
  const transcript = await pool.query(
    "SELECT ai_key_points FROM transcripts WHERE media_id=$1",
    [mediaId]
  );
  if (transcript.rows.length === 0) throw new Error("Transcript not found");

  const keyPoints = transcript.rows[0].ai_key_points;
  if (!Array.isArray(keyPoints) || keyPoints.length === 0) {
    throw new Error("No key points yet — run the AI pipeline first");
  }

  const chunks = await pool.query(
    "SELECT start_time, content FROM transcript_chunks WHERE media_id=$1 ORDER BY chunk_index",
    [mediaId]
  );
  if (chunks.rows.length === 0) throw new Error("No transcript content to map");

  // Trim each chunk to its opening words — enough for GPT to recognise the
  // topic without spending tokens on the full text of a multi-hour lecture.
  const chunkView = chunks.rows
    .map((r) => {
      const preview = r.content.split(/\s+/).slice(0, HEADING_PREVIEW_WORDS).join(" ");
      return `[start_time=${r.start_time}] ${preview}`;
    })
    .join("\n\n");

  const userContent = `נקודות מפתח:\n${keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n\nקטעי התמלול:\n${chunkView}`;

  console.log(`[BE:svc] generateKeyPointHeadings mediaId=${mediaId} — ${keyPoints.length} key points over ${chunks.rows.length} chunks → GPT-4o`);
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: HEADINGS_PROMPT },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
  });

  const parsed = JSON.parse(response.choices[0].message.content);
  const headings = Array.isArray(parsed.headings) ? parsed.headings : [];
  // Defensive: keep only well-formed entries and sort by time, in case the
  // model returns something slightly off.
  const clean = headings
    .filter((h) => h && typeof h.title === "string" && Number.isFinite(Number(h.start_time)))
    .map((h) => ({ title: h.title, start_time: Math.floor(Number(h.start_time)) }))
    .sort((a, b) => a.start_time - b.start_time);

  const result = await pool.query(
    "UPDATE transcripts SET ai_key_point_headings=$1, updated_at=NOW() WHERE media_id=$2 RETURNING *",
    [JSON.stringify(clean), mediaId]
  );
  console.log(`[BE:svc] generateKeyPointHeadings mediaId=${mediaId} ✓ ${clean.length} headings saved`);
  return result.rows[0];
};

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
  console.log(`[BE:svc] saveChunks mediaId=${mediaId} — ${segments.length} segments → ${chunks.length} chunks`);
  await pool.query("DELETE FROM transcript_chunks WHERE media_id=$1", [mediaId]);

  for (const chunk of chunks) {
    await pool.query(
      `INSERT INTO transcript_chunks (media_id, chunk_index, start_time, end_time, content)
       VALUES ($1, $2, $3, $4, $5)`,
      [mediaId, chunk.chunk_index, chunk.start_time, chunk.end_time, chunk.content]
    );
  }
  console.log(`[BE:svc] saveChunks mediaId=${mediaId} ✓ ${chunks.length} chunks written`);
  return chunks.length;
};

export const getTranscriptByMediaId = async (mediaId) => {
  console.log(`[BE:svc] getTranscriptByMediaId mediaId=${mediaId}`);
  const [transcript, chunks] = await Promise.all([
    pool.query("SELECT * FROM transcripts WHERE media_id=$1", [mediaId]),
    pool.query(
      "SELECT * FROM transcript_chunks WHERE media_id=$1 ORDER BY chunk_index",
      [mediaId]
    ),
  ]);

  if (transcript.rows.length === 0) {
    console.log(`[BE:svc] getTranscriptByMediaId mediaId=${mediaId} ✗ not found`);
    throw new Error("Transcript not found");
  }

  console.log(`[BE:svc] getTranscriptByMediaId mediaId=${mediaId} ✓ status=${transcript.rows[0].status} chunks=${chunks.rows.length}`);
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
    console.log(`[BE:svc] triggerPipeline mediaId=${mediaId} ✗ media not found`);
    throw new Error("Media not found");
  }
  if (media.rows[0].media_type === "text") {
    console.log(`[BE:svc] triggerPipeline mediaId=${mediaId} ✗ text media`);
    throw new Error("Transcription is not available for text media");
  }
  console.log(`[BE:svc] triggerPipeline mediaId=${mediaId} type=${media.rows[0].media_type} s3Key=${media.rows[0].s3_key}`);

  await pool.query(
    `INSERT INTO transcripts (media_id, status) VALUES ($1, 'pending')
     ON CONFLICT (media_id) DO UPDATE SET status='pending', updated_at=NOW()`,
    [mediaId]
  );
  console.log(`[BE:svc] triggerPipeline mediaId=${mediaId} ✓ row set to 'pending'`);

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
