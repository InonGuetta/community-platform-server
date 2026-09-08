// @ts-check
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
import { pool } from "../../db/pool.js";
import { visibleMediaSql } from "../../lib/permissions.js";
import { logger } from "../../lib/logger.js";
import { completionJson } from "../../lib/openaiClient.js";
import { embedQuery, toVectorLiteral } from "../servicesEmbeddings.js";
import { openai, GPT_MODEL } from "./gpt.js";

const RRF_K = 60;
const SEARCH_LIMIT = 30;
const FUSE_DEPTH = 60; // how deep each list goes into the fusion
const SEMANTIC_SNIPPET_CHARS = 200;
// hybrid fetches more candidates than it returns so the reranker has a pool to
// reorder; the LLM then picks the best SEARCH_LIMIT.
const CANDIDATE_LIMIT = 40;
// Chunks are ~500 words (CHUNK_WORDS in ./chunks.js). The reranker must see the
// WHOLE chunk, not a slice — judging relevance on the first 100 words missed
// content that sat later in the chunk and depressed scores. 600 covers a full
// chunk with margin; 40 candidates × ~600 words stays well within gpt-4o's
// context window.
const RERANK_PREVIEW_WORDS = 600;
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
    model: GPT_MODEL,
    messages: [
      { role: "system", content: RERANK_PROMPT },
      { role: "user", content: `שאילתה: ${query}\n\nקטעים:\n${list}` },
    ],
    response_format: { type: "json_object" },
  });

  const parsed = completionJson(response, "searchHybrid/rerank");
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

// Visibility predicate, shared by all three modes — and now with every other
// read of media in the application, which is why it comes from lib/permissions.js
// rather than being defined here. A chunk is searchable when its media item is
// published, or when the caller may see drafts. The boolean is a bound parameter
// rather than string-built SQL so the query text stays identical for every caller
// and stays in the plan cache.
//
// CRITICAL for hybrid: this has to sit INSIDE each ranking CTE, not only in the
// final SELECT. The CTEs take the top FUSE_DEPTH candidates first — filtering
// afterwards would let hidden chunks consume candidate slots and silently hand
// a student a shorter, worse-ranked list rather than an equivalent one. That
// remains true of whatever condition the shared predicate grows next.
const VISIBLE = visibleMediaSql;

const searchKeyword = async (query, scope) => {
  const result = await pool.query(
    `SELECT
       ${SELECT_COLS},
       ts_headline('simple', c.content, plainto_tsquery('simple', $1),
         'MaxWords=20, MinWords=5') AS headline
     FROM transcript_chunks c
     JOIN media_items m ON c.media_id = m.id
     WHERE to_tsvector('simple', c.content) @@ plainto_tsquery('simple', $1)
       AND ${VISIBLE("$2", "m", "$3")}
     ORDER BY ts_rank(to_tsvector('simple', c.content), plainto_tsquery('simple', $1)) DESC
     LIMIT ${SEARCH_LIMIT}`,
    [query, scope.courses, scope.drafts]
  );
  return result.rows;
};

const searchSemantic = async (query, scope) => {
  const queryVector = toVectorLiteral(await embedQuery(query));
  const result = await pool.query(
    `SELECT
       ${SELECT_COLS},
       LEFT(c.content, ${SEMANTIC_SNIPPET_CHARS}) AS headline,
       1 - (c.embedding <=> $1::vector) AS similarity
     FROM transcript_chunks c
     JOIN media_items m ON c.media_id = m.id
     WHERE c.embedding IS NOT NULL
       AND ${VISIBLE("$2", "m", "$3")}
     ORDER BY c.embedding <=> $1::vector
     LIMIT ${SEARCH_LIMIT}`,
    [queryVector, scope.courses, scope.drafts]
  );
  return result.rows;
};

const searchHybrid = async (query, scope) => {
  const queryVector = toVectorLiteral(await embedQuery(query));
  // $1 = query text (FTS), $2 = query embedding (vector), $3 = may see drafts.
  // Each CTE ranks its own top FUSE_DEPTH; the FULL OUTER JOIN unions the two id
  // sets and RRF sums the reciprocal ranks. ts_headline highlights the FTS terms
  // (semantic-only hits simply have no terms to highlight, which is fine).
  // Both CTEs join media_items solely to apply the visibility predicate.
  const result = await pool.query(
    `WITH kw AS (
       SELECT c.id,
         row_number() OVER (
           ORDER BY ts_rank(to_tsvector('simple', c.content), plainto_tsquery('simple', $1)) DESC
         ) AS rank
       FROM transcript_chunks c
       JOIN media_items m ON c.media_id = m.id
       WHERE to_tsvector('simple', c.content) @@ plainto_tsquery('simple', $1)
         AND ${VISIBLE("$3", "m", "$4")}
       ORDER BY rank
       LIMIT ${FUSE_DEPTH}
     ),
     vec AS (
       SELECT c.id,
         row_number() OVER (ORDER BY c.embedding <=> $2::vector) AS rank
       FROM transcript_chunks c
       JOIN media_items m ON c.media_id = m.id
       WHERE c.embedding IS NOT NULL
         AND ${VISIBLE("$3", "m", "$4")}
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
    [query, queryVector, scope.courses, scope.drafts]
  );

  // Rerank the candidates with GPT-4o for true relevance ordering + scoring.
  // Best-effort: if the LLM call/parse fails, return the RRF order untouched so
  // search never breaks (those rows keep their cosine `similarity`).
  try {
    const reranked = await rerankByRelevance(query, result.rows);
    logger.debug(`[BE:svc] searchHybrid ✓ reranked ${result.rows.length} → ${reranked.length}`);
    return reranked;
  } catch (err) {
    logger.warn(`[BE:svc] searchHybrid rerank failed (non-fatal) — ${err.message}`);
    return result.rows.slice(0, SEARCH_LIMIT);
  }
};

export const searchTranscripts = async (query, mode = "hybrid", scope = { courses: [], drafts: [] }) => {
  logger.debug(`[BE:svc] searchTranscripts mode=${mode} qLen=${query.length} visible=${JSON.stringify(scope.courses)}`);
  if (mode === "keyword") return searchKeyword(query, scope);
  if (mode === "semantic") return searchSemantic(query, scope);
  return searchHybrid(query, scope);
};
