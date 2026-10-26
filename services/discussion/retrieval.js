// @ts-check
// ── Search inside ONE lesson ─────────────────────────────────────────────────
//
// The "דיון עם AI" tab works on one lesson at a time: its smart search, and the
// chat that will sit on top of the same retrieval, may only ever see the chunks
// of the lesson they were opened on. Those chunks already exist — every
// recording's transcript and every book's extracted text is in transcript_chunks
// with its embedding (migrations 007, 010, 013, 023) — so a lesson's "RAG" is not
// a second store. It is `WHERE media_id = $1`, and this module is the one place
// that clause is applied.
//
// Same shape of answer as the library-wide search in ../transcripts/search.js
// (keyword + vector, fused by RRF, reranked by GPT-4o), with two differences
// that are the reason this is a module of its own rather than a fourth mode
// there:
//
// 1. The vector half is EXACT, not the HNSW index. pgvector filters after the
//    index scan, and the index walk yields ~40 nearest neighbours from the WHOLE
//    archive; filtered down to one lesson, that is usually zero or one row. The
//    MATERIALIZED CTE below takes the lesson's own chunks first, and ORDER BY
//    over a materialized CTE cannot use an index — so the planner has no way to
//    choose the walk that loses rows. A lesson is tens to a few hundred chunks;
//    an exact scan of that is a millisecond.
//
// 2. It degrades rather than fails. If the query embedding cannot be made
//    (OpenAI down, quota), the keyword half still answers; if the rerank fails,
//    the fused order stands. A search that works worse is better than a tab that
//    shows an error for a reason the student cannot act on.
//
// Every reading of transcript_chunks here carries `media_id = $1`. The test
// suite asserts exactly that on every statement this module issues, because a
// query that forgot it would answer from another lesson — silently, and with
// plausible-looking text.
import { pool } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { assertCanSeeLesson } from "./access.js";
import { embedQuery, toVectorLiteral } from "../servicesEmbeddings.js";
import { rerankByRelevance, RRF_K, FUSE_DEPTH } from "../transcripts/search.js";

// Candidates handed to the reranker, and results that survive it. Smaller than
// the library-wide 40/30: one lesson rarely has 15 genuinely different passages
// about the same question, and every candidate is ~600 words of paid input.
const CANDIDATE_LIMIT = 15;
export const RESULT_LIMIT = 8;

/**
 * @typedef {object} RetrievalDeps
 * @property {(q: string) => Promise<number[]>} embed
 * @property {(q: string, rows: any[], limit?: number) => Promise<any[]>} rerank
 */

// The two OpenAI calls, injectable so the tests can drive the real SQL without
// a network. Production never passes anything.
/** @type {RetrievalDeps} */
const DEFAULT_DEPS = { embed: embedQuery, rerank: rerankByRelevance };

// ── Matching a word inside a Hebrew word ────────────────────────────────────
//
// The keyword half cannot rest on full-text search alone. The 'simple'
// dictionary matches WHOLE words, and Hebrew glues its prepositions and
// articles onto the word: a lesson that says "שאמריקאים", "והתשובה",
// "בתפילה" never matches a search for "אמריקאים", "תשובה", "תפילה". Found in
// the browser on a real lesson, where every form of the searched word was one
// of these and the search came back empty.
//
// Within ONE lesson a substring test is cheap — tens of rows, not the archive —
// so the keyword half also accepts a chunk containing a query word anywhere
// inside a word, and a query word typed WITH a prefix is tried without it too.
// When the embedding is available the vector half covers most of this by
// meaning; when it is not (OpenAI down, out of credit) this is what keeps the
// search useful at all.
const HEBREW_PREFIXES = "והבכלמש";
// Two-letter words — על, של, מה, זה — appear in every chunk and would only
// rank noise. Three letters is the shortest root worth matching inside a word.
const MIN_PATTERN_CHARS = 3;
const MAX_PATTERNS = 10;

/**
 * ILIKE patterns for the words of a query.
 * Only letters, digits and the Hebrew quote marks of abbreviations (רמב"ם)
 * are kept from each word — which also means no %, _ or backslash can reach
 * the pattern from the user.
 * @param {string} query
 */
export const substringPatterns = (query) => {
  const patterns = new Set();
  for (const raw of String(query).split(/\s+/)) {
    const word = raw.replace(/[^\p{L}\p{N}"'׳״]/gu, "").replace(/^["'׳״]+|["'׳״]+$/g, "");
    if (word.length < MIN_PATTERN_CHARS) continue;
    patterns.add(`%${word}%`);
    if (word.length > MIN_PATTERN_CHARS && HEBREW_PREFIXES.includes(word[0])) {
      patterns.add(`%${word.slice(1)}%`);
    }
  }
  return [...patterns].slice(0, MAX_PATTERNS);
};

// ts_headline marks only what full-text search matched, so a chunk found by a
// word INSIDE a word came back with a snippet from its first line and nothing
// marked — the reader could not see why it was a hit. This builds the snippet
// around the first such match instead, and marks each one the same way
// ts_headline does (<b>…</b>), so the client renders both kinds alike.
//
// Only for rows ts_headline left unmarked: where FTS matched, its snippet is
// already the right one.
const SNIPPET_BEFORE = 80;
const SNIPPET_AFTER = 160;

/**
 * @param {string} content
 * @param {string[]} patterns  from substringPatterns — "%word%"
 * @returns {string|null}  null when no pattern occurs in the content
 */
export const substringHeadline = (content, patterns) => {
  const words = patterns.map((p) => p.slice(1, -1)).filter(Boolean)
    // Longest first, so "התשובה" is marked whole rather than its "תשובה".
    .sort((a, b) => b.length - a.length);
  let first = -1;
  for (const w of words) {
    const at = content.indexOf(w);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }
  if (first === -1) return null;

  // Widen to whole words so the snippet does not open or close mid-word.
  let start = Math.max(0, first - SNIPPET_BEFORE);
  let end = Math.min(content.length, first + SNIPPET_AFTER);
  if (start > 0) start = content.indexOf(" ", start) + 1 || start;
  if (end < content.length) end = content.lastIndexOf(" ", end) > first ? content.lastIndexOf(" ", end) : end;
  const snippet = content.slice(start, end);

  // The words are letters, digits and Hebrew quote marks only (see
  // substringPatterns), but escaping keeps that a property of this line too.
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return snippet.replace(new RegExp(escaped.join("|"), "g"), (m) => `<b>${m}</b>`);
};

const withSubstringHeadlines = (rows, patterns) =>
  rows.map((row) => {
    if (String(row.headline ?? "").includes("<b>")) return row;
    const headline = substringHeadline(String(row.content ?? ""), patterns);
    return headline ? { ...row, headline } : row;
  });

// Shared by both variants. `$1` is always the media id; `$2` the query text;
// `patterns` names the placeholder holding substringPatterns(query).
//
// Ranked by how many of the query's words a chunk contains, then by FTS rank:
// a chunk holding both words of a two-word question beats one that holds one
// of them twice.
const lessonCte = (patterns) => `
  lesson AS MATERIALIZED (
    SELECT id, content, embedding
    FROM transcript_chunks
    WHERE media_id = $1
  ),
  kw AS (
    SELECT id,
      row_number() OVER (
        ORDER BY
          (SELECT count(*) FROM unnest(${patterns}::text[]) AS pat WHERE content ILIKE pat) DESC,
          ts_rank(to_tsvector('simple', content), plainto_tsquery('simple', $2)) DESC
      ) AS rank
    FROM lesson
    WHERE to_tsvector('simple', content) @@ plainto_tsquery('simple', $2)
       OR content ILIKE ANY(${patterns}::text[])
    ORDER BY rank
    LIMIT ${FUSE_DEPTH}
  )`;

// Everything the client needs to place a hit: the time for a recording, the
// page (and character offset) for a book. The embedding is never selected — it
// is 1536 floats per row that the client has no use for.
const RESULT_COLS = `
  c.id, c.chunk_index, c.start_time, c.end_time, c.page_number,
  c.char_start, c.char_end, c.content,
  ts_headline('simple', c.content, plainto_tsquery('simple', $2),
    'MaxWords=25, MinWords=8') AS headline`;

// Keyword + exact vector, fused by RRF. `$3` is the query embedding, `$4` the
// substring patterns.
const HYBRID_SQL = `
  WITH ${lessonCte("$4")},
  vec AS (
    SELECT id, row_number() OVER (ORDER BY embedding <=> $3::vector) AS rank
    FROM lesson
    WHERE embedding IS NOT NULL
    ORDER BY rank
    LIMIT ${FUSE_DEPTH}
  ),
  fused AS (
    SELECT
      COALESCE(kw.id, vec.id) AS id,
      COALESCE(1.0 / (${RRF_K} + kw.rank), 0) +
      COALESCE(1.0 / (${RRF_K} + vec.rank), 0) AS score
    FROM kw FULL OUTER JOIN vec ON kw.id = vec.id
  )
  SELECT ${RESULT_COLS},
    CASE WHEN c.embedding IS NULL THEN NULL
         ELSE 1 - (c.embedding <=> $3::vector) END AS similarity
  FROM fused f
  JOIN transcript_chunks c ON c.id = f.id AND c.media_id = $1
  ORDER BY f.score DESC, c.chunk_index
  LIMIT ${CANDIDATE_LIMIT}`;

// Keyword only — what is left when the query could not be embedded. `$3` is
// the substring patterns.
const KEYWORD_SQL = `
  WITH ${lessonCte("$3")}
  SELECT ${RESULT_COLS}, NULL::float AS similarity
  FROM kw
  JOIN transcript_chunks c ON c.id = kw.id AND c.media_id = $1
  ORDER BY kw.rank, c.chunk_index
  LIMIT ${CANDIDATE_LIMIT}`;

/**
 * Smart search inside one lesson.
 * @param {number|string} mediaId
 * @param {string} query
 * @param {{ courses: number[]|null, drafts: number[]|null }} scope  from viewerScopeFor
 * @param {RetrievalDeps} [deps]
 */
export const searchWithinMedia = async (mediaId, query, scope, deps = DEFAULT_DEPS) => {
  await assertCanSeeLesson(mediaId, scope);

  let vector = null;
  try {
    vector = toVectorLiteral(await deps.embed(query));
  } catch (err) {
    logger.warn(`[BE:svc] searchWithinMedia mediaId=${mediaId} embed failed, keyword only — ${err.message}`);
  }

  const patterns = substringPatterns(query);
  const { rows: found } = vector
    ? await pool.query(HYBRID_SQL, [mediaId, query, vector, patterns])
    : await pool.query(KEYWORD_SQL, [mediaId, query, patterns]);
  const rows = withSubstringHeadlines(found, patterns);

  logger.debug(`[BE:svc] searchWithinMedia mediaId=${mediaId} qLen=${query.length} mode=${vector ? "hybrid" : "keyword"} candidates=${rows.length}`);

  // No embedding means OpenAI is not answering; a rerank would only wait out a
  // second failure. Nothing to rerank is nothing to pay for.
  if (!vector || rows.length === 0) return rows.slice(0, RESULT_LIMIT);

  try {
    return await deps.rerank(query, rows, RESULT_LIMIT);
  } catch (err) {
    logger.warn(`[BE:svc] searchWithinMedia mediaId=${mediaId} rerank failed (non-fatal) — ${err.message}`);
    return rows.slice(0, RESULT_LIMIT);
  }
};
