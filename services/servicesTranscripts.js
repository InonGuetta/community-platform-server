import OpenAI from "openai";
import { pool } from "../db/pool.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { embedQuery, toVectorLiteral } from "./servicesEmbeddings.js";

const CHUNK_WORDS = 500;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 5 * 60 * 1000,
  // 5 retries: long transcripts are analysed in several calls that share the
  // org's per-minute token budget. A call that trips the 30k TPM limit returns
  // 429 + Retry-After; the SDK waits and retries, so batches self-pace.
  maxRetries: 5,
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

// ── AI analysis (summary + key points) ──────────────────────────────────────
// Shared by the LLM worker (auto, after transcription) and by the headings
// feature (on demand, if the auto step failed/was skipped). Short transcripts
// go to GPT in one call; long ones are condensed batch-by-batch first (map) and
// the batch summaries analysed together (reduce), so no single call exceeds the
// TPM limit — which is what silently broke multi-hour lectures.
const ANALYSIS_BATCH_WORDS = 5000;

const ANALYSIS_MAP_PROMPT = `אתה מקבל קטע מתוך תמלול של הרצאה/שיעור בעברית. סכם בעברית, ב-3–4 משפטים, את התוכן המרכזי של הקטע הזה בלבד. החזר טקסט רגיל בלבד, בלי כותרות ובלי markdown.`;

// How many key points a transcript of `wordCount` words warrants. The count
// scales with length so a 3-hour lecture (~22k words) gets ~10–15 sections, not
// a fixed 3, while a short clip stays at 3. The model picks the exact number
// within this range based on how many distinct topics actually exist.
const keyPointRange = (wordCount) => {
  const target = Math.round(wordCount / 1800);
  const min = Math.max(3, target - 2);
  const max = Math.min(20, Math.max(min + 2, target + 3));
  return { min, max };
};

// Built per call so the requested count tracks the transcript's length.
const analysisPrompt = (min, max) => `אתה מנתח תוכן מומחה. תקבל תמלול של הרצאה/שיעור בעברית (או תקצירים מסודרים שלו לפי הסדר).
החזר אובייקט JSON עם השדות הבאים בדיוק — כל הטקסט (summary, key_points) חייב להיות **בעברית**:
{
  "summary": "פסקה תמציתית של 3–5 משפטים המסכמת את התוכן העיקרי",
  "key_points": ["נקודה מרכזית 1", "נקודה מרכזית 2", "..."]
}
לגבי key_points: החזר בין ${min} ל-${max} נקודות מפתח — כמספר הנושאים/הקטעים המובחנים שבאמת קיימים בתוכן, לפי סדר הופעתם. אל תמתח או תמציא נקודות סתם כדי למלא, אבל אם יש הרבה נושאים — פרט אותם ואל תצטמצם ל-3.
שמות השדות נשארים באנגלית (summary, key_points). רק הערכים בעברית.
החזר רק JSON תקין — בלי markdown, בלי הסברים, בלי \`\`\`.`;

const summarizeBatch = async (text) => {
  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: ANALYSIS_MAP_PROMPT },
      { role: "user", content: text },
    ],
  });
  return r.choices[0].message.content.trim();
};

export const analyzeTranscript = async (rawText) => {
  const words = rawText.split(/\s+/);
  const { min, max } = keyPointRange(words.length);
  let input = rawText;

  if (words.length > ANALYSIS_BATCH_WORDS) {
    const batches = [];
    for (let i = 0; i < words.length; i += ANALYSIS_BATCH_WORDS) {
      batches.push(words.slice(i, i + ANALYSIS_BATCH_WORDS).join(" "));
    }
    console.log(`[BE:svc] analyzeTranscript — long text ${words.length} words → ${batches.length} batch(es) (map)`);
    const partials = [];
    for (let i = 0; i < batches.length; i++) {
      console.log(`[BE:svc]   map ${i + 1}/${batches.length} → GPT-4o`);
      partials.push(await summarizeBatch(batches[i]));
    }
    input = partials.join("\n\n");
  }

  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: analysisPrompt(min, max) },
      { role: "user", content: input },
    ],
    response_format: { type: "json_object" },
  });
  return JSON.parse(r.choices[0].message.content);
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

  const chunks = await pool.query(
    "SELECT start_time, end_time, content FROM transcript_chunks WHERE media_id=$1 ORDER BY chunk_index",
    [mediaId]
  );
  if (chunks.rows.length === 0) throw new Error("No transcript content yet — run transcription first");

  const rawText = chunks.rows.map((r) => r.content).join("\n\n");
  const totalWords = rawText.split(/\s+/).length;
  const warrantedMin = keyPointRange(totalWords).min;

  let keyPoints = transcript.rows[0].ai_key_points;
  // (Re)generate key points from the existing chunks — no re-transcription — when
  // they're missing (the auto step failed) OR there are too few for the length.
  // The second case covers transcripts whose points were made before the count
  // became length-adaptive: e.g. a 3-hour lecture stuck at 3 points gets ~12.
  if (!Array.isArray(keyPoints) || keyPoints.length < warrantedMin) {
    console.log(`[BE:svc] generateKeyPointHeadings mediaId=${mediaId} — key points ${keyPoints?.length ?? 0} < ${warrantedMin}, re-analysing transcript`);
    const analysis = await analyzeTranscript(rawText);
    keyPoints = Array.isArray(analysis.key_points) ? analysis.key_points : [];
    if (keyPoints.length === 0) throw new Error("AI analysis produced no key points");
    await pool.query(
      "UPDATE transcripts SET ai_summary=$1, ai_key_points=$2, status='done', updated_at=NOW() WHERE media_id=$3",
      [analysis.summary, JSON.stringify(keyPoints), mediaId]
    );
    console.log(`[BE:svc] generateKeyPointHeadings mediaId=${mediaId} ✓ generated ${keyPoints.length} key points`);
  }

  const validStarts = chunks.rows.map((c) => c.start_time);
  const endByStart = new Map(chunks.rows.map((c) => [c.start_time, c.end_time]));
  // Snap a model-provided time to the nearest real chunk start, so a slightly
  // off number still lands on a known position.
  const snapToChunk = (t) =>
    validStarts.reduce((best, s) => (Math.abs(s - t) < Math.abs(best - t) ? s : best), validStarts[0]);

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

  // Keep only well-formed entries, snapping each to a real chunk start.
  const valid = headings
    .filter((h) => h && typeof h.title === "string" && h.title.trim() && Number.isFinite(Number(h.start_time)))
    .map((h) => ({ title: h.title.trim(), start: snapToChunk(Math.floor(Number(h.start_time))) }));

  // Timestamps only have chunk-level resolution, so several key points can land
  // on the same chunk → identical times. Group by chunk and spread each group
  // evenly across that chunk's [start, end] window so no two headings share a
  // time (this is the "same time twice" bug).
  const byChunk = new Map();
  for (const v of valid) {
    if (!byChunk.has(v.start)) byChunk.set(v.start, []);
    byChunk.get(v.start).push(v.title);
  }

  const clean = [];
  for (const [start, titles] of byChunk) {
    const end = endByStart.get(start) ?? start;
    const span = Math.max(0, end - start);
    titles.forEach((title, i) => {
      const offset = titles.length > 1 ? Math.floor((span * i) / titles.length) : 0;
      clean.push({ title, start_time: start + offset });
    });
  }
  clean.sort((a, b) => a.start_time - b.start_time);

  // Final guard: force strictly-increasing times so even a degenerate case
  // (chunk with zero span, or rounding collisions) can't produce duplicates.
  for (let i = 1; i < clean.length; i++) {
    if (clean[i].start_time <= clean[i - 1].start_time) {
      clean[i].start_time = clean[i - 1].start_time + 1;
    }
  }

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
    // Explicit columns (not SELECT *) so the embedding vector(1536) — added in
    // migration 010 — never ships to the client on every transcript load.
    pool.query(
      "SELECT id, media_id, chunk_index, start_time, end_time, content FROM transcript_chunks WHERE media_id=$1 ORDER BY chunk_index",
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

// ── Transcript search ────────────────────────────────────────────────────────
// Three modes, all returning the SAME row shape so the client never needs to
// branch on mode: { media_id, chunk_index, start_time, end_time, content,
// media_title, headline }.
//   keyword  — the original full-text search (FTS over to_tsvector('simple')).
//   semantic — pure vector nearest-neighbour over the embeddings (meaning, not
//              words). No FTS terms, so the snippet is the chunk's opening text.
//   hybrid   — fuses keyword + semantic with Reciprocal Rank Fusion (RRF, k=60):
//              each result's score is Σ 1/(k + rank_in_each_list). This is the
//              default; it catches both exact-word and meaning matches.
const RRF_K = 60;
const SEARCH_LIMIT = 30;
const FUSE_DEPTH = 60; // how deep each list goes into the fusion
const SEMANTIC_SNIPPET_CHARS = 200;
// hybrid fetches more candidates than it returns so the reranker has a pool to
// reorder; the LLM then picks the best SEARCH_LIMIT.
const CANDIDATE_LIMIT = 40;
const RERANK_PREVIEW_WORDS = 100;
// Below this rerank relevance a hit is treated as noise and hidden entirely.
const RELEVANCE_FLOOR = 0.1;

// LLM reranking: the embedding/FTS fusion is good at *recall* (pulling the right
// candidates) but its scores don't reflect true relevance well — cosine values
// sit in a narrow band and RRF is rank-only. GPT-4o reads the query and each
// candidate together (a cross-encoder-style judgment) and scores 0–100 how well
// the segment actually matches the query's meaning. We reorder by that score and
// expose it as `similarity` (0–1) so the UI's colour tiers finally sit on a
// meaningful scale. Best-effort: any failure falls back to the RRF order.
const RERANK_PROMPT = `אתה מדרג רלוונטיות בחיפוש. תקבל שאילתת חיפוש ורשימת קטעי תמלול ממוספרים בעברית.
לכל קטע תן ציון שלם בין 0 ל-100: עד כמה הקטע באמת רלוונטי *במשמעות* לשאילתה — 100 = בדיוק על הנושא שחיפשו, 0 = לא קשור כלל. אל תתגמל הופעה מקרית של מילה; דרג לפי התוכן.
החזר JSON תקין בלבד במבנה: { "scores": [{ "index": <מספר הקטע>, "score": <0-100> }] } — ציון לכל הקטעים שקיבלת, בלי markdown ובלי הסברים.`;

const rerankByRelevance = async (query, rows) => {
  if (rows.length === 0) return rows;
  const list = rows
    .map((r, i) => `${i + 1}. ${r.content.split(/\s+/).slice(0, RERANK_PREVIEW_WORDS).join(" ")}`)
    .join("\n\n");

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: RERANK_PROMPT },
      { role: "user", content: `שאילתה: ${query}\n\nקטעים:\n${list}` },
    ],
    response_format: { type: "json_object" },
  });

  const parsed = JSON.parse(response.choices[0].message.content);
  const scoreByIndex = parseRerankScores(parsed);

  // If NOTHING parsed (the model returned an unexpected shape), don't zero every
  // result — throw so the caller falls back to the RRF/cosine order.
  if (scoreByIndex.size === 0) throw new Error("rerank returned no usable scores");

  // Overwrite `similarity` with the LLM relevance (0–1) — a far better colour
  // signal than raw cosine. A row the model didn't score falls back to its
  // cosine (never 0). Keep the cosine under `cosine` for reference.
  const scored = rows.map((r, i) => {
    const score = scoreByIndex.get(i + 1);
    const relevance = Number.isFinite(score) ? score / 100 : null;
    return {
      ...r,
      cosine: r.similarity,
      similarity: relevance ?? r.similarity ?? 0,
    };
  });
  scored.sort((a, b) => b.similarity - a.similarity);
  // Drop near-zero / irrelevant hits so the list isn't padded with 0% noise.
  return scored.filter((r) => r.similarity >= RELEVANCE_FLOOR).slice(0, SEARCH_LIMIT);
};

// Pull { index → score } out of whatever shape GPT-4o returned. Tolerates the
// array forms ({scores|results|data: [{index,score}]} or a bare array) and the
// object-map form ({ "1": 80, ... }). Field-name variants are accepted too.
const parseRerankScores = (parsed) => {
  const arr =
    (Array.isArray(parsed) && parsed) ||
    (Array.isArray(parsed?.scores) && parsed.scores) ||
    (Array.isArray(parsed?.results) && parsed.results) ||
    (Array.isArray(parsed?.data) && parsed.data) ||
    null;

  const map = new Map();
  if (arr) {
    for (const s of arr) {
      const idx = Number(s.index ?? s.i ?? s.id ?? s.idx);
      const score = Number(s.score ?? s.relevance ?? s.rating ?? s.value);
      if (Number.isFinite(idx) && Number.isFinite(score)) map.set(idx, score);
    }
    return map;
  }

  // Object-map fallback: { "1": 80, "2": 65 } possibly nested under `scores`.
  const obj = parsed?.scores && typeof parsed.scores === "object" ? parsed.scores : parsed;
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      const idx = Number(k);
      const score = Number(v);
      if (Number.isFinite(idx) && Number.isFinite(score)) map.set(idx, score);
    }
  }
  return map;
};

const SELECT_COLS = `
  c.media_id, c.chunk_index, c.start_time, c.end_time, c.content,
  m.title AS media_title`;

const searchKeyword = async (query) => {
  const result = await pool.query(
    `SELECT
       ${SELECT_COLS},
       ts_headline('simple', c.content, plainto_tsquery('simple', $1),
         'MaxWords=20, MinWords=5') AS headline
     FROM transcript_chunks c
     JOIN media_items m ON c.media_id = m.id
     WHERE to_tsvector('simple', c.content) @@ plainto_tsquery('simple', $1)
     ORDER BY ts_rank(to_tsvector('simple', c.content), plainto_tsquery('simple', $1)) DESC
     LIMIT ${SEARCH_LIMIT}`,
    [query]
  );
  return result.rows;
};

const searchSemantic = async (query) => {
  const queryVector = toVectorLiteral(await embedQuery(query));
  const result = await pool.query(
    `SELECT
       ${SELECT_COLS},
       LEFT(c.content, ${SEMANTIC_SNIPPET_CHARS}) AS headline,
       1 - (c.embedding <=> $1::vector) AS similarity
     FROM transcript_chunks c
     JOIN media_items m ON c.media_id = m.id
     WHERE c.embedding IS NOT NULL
     ORDER BY c.embedding <=> $1::vector
     LIMIT ${SEARCH_LIMIT}`,
    [queryVector]
  );
  return result.rows;
};

const searchHybrid = async (query) => {
  const queryVector = toVectorLiteral(await embedQuery(query));
  // $1 = query text (FTS), $2 = query embedding (vector). Each CTE ranks its own
  // top FUSE_DEPTH; the FULL OUTER JOIN unions the two id sets and RRF sums the
  // reciprocal ranks. ts_headline highlights the FTS terms (semantic-only hits
  // simply have no terms to highlight, which is fine).
  const result = await pool.query(
    `WITH kw AS (
       SELECT c.id,
         row_number() OVER (
           ORDER BY ts_rank(to_tsvector('simple', c.content), plainto_tsquery('simple', $1)) DESC
         ) AS rank
       FROM transcript_chunks c
       WHERE to_tsvector('simple', c.content) @@ plainto_tsquery('simple', $1)
       ORDER BY rank
       LIMIT ${FUSE_DEPTH}
     ),
     vec AS (
       SELECT c.id,
         row_number() OVER (ORDER BY c.embedding <=> $2::vector) AS rank
       FROM transcript_chunks c
       WHERE c.embedding IS NOT NULL
       ORDER BY c.embedding <=> $2::vector
       LIMIT ${FUSE_DEPTH}
     ),
     fused AS (
       SELECT
         COALESCE(kw.id, vec.id) AS id,
         COALESCE(1.0 / (${RRF_K} + kw.rank), 0) +
         COALESCE(1.0 / (${RRF_K} + vec.rank), 0) AS score
       FROM kw FULL OUTER JOIN vec ON kw.id = vec.id
     )
     SELECT
       ${SELECT_COLS},
       ts_headline('simple', c.content, plainto_tsquery('simple', $1),
         'MaxWords=20, MinWords=5') AS headline,
       1 - (c.embedding <=> $2::vector) AS similarity
     FROM fused f
     JOIN transcript_chunks c ON c.id = f.id
     JOIN media_items m ON c.media_id = m.id
     ORDER BY f.score DESC
     LIMIT ${CANDIDATE_LIMIT}`,
    [query, queryVector]
  );

  // Rerank the candidates with GPT-4o for true relevance ordering + scoring.
  // Best-effort: if the LLM call/parse fails, return the RRF order untouched so
  // search never breaks (those rows keep their cosine `similarity`).
  try {
    const reranked = await rerankByRelevance(query, result.rows);
    console.log(`[BE:svc] searchHybrid ✓ reranked ${result.rows.length} → ${reranked.length}`);
    return reranked;
  } catch (err) {
    console.error(`[BE:svc] searchHybrid ⚠ rerank failed (non-fatal) — ${err.message}`);
    return result.rows.slice(0, SEARCH_LIMIT);
  }
};

export const searchTranscripts = async (query, mode = "hybrid") => {
  console.log(`[BE:svc] searchTranscripts mode=${mode} q="${query}"`);
  if (mode === "keyword") return searchKeyword(query);
  if (mode === "semantic") return searchSemantic(query);
  return searchHybrid(query);
};
