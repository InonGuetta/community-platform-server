// @ts-check
// Splitting an extracted book into the same shape of chunk that transcription
// produces, so everything downstream — full-text search, embeddings, the hybrid
// RRF query, the reranker — works on books without knowing they are books.
//
// The difference from the audio path is what defines a boundary. Whisper gives
// segments with timestamps, so splitSegmentsToChunks accumulates speech until it
// has enough words. A document has no timeline but it does have paragraphs, and
// a paragraph is a far better semantic boundary than a word count: cutting
// mid-paragraph puts half an argument in one embedding and half in the next,
// which is exactly what makes a search hit land on the wrong chunk.
//
// Every chunk carries char_start/char_end — its offset into the extracted text.
// Character offsets are the one anchor every format can produce (a .txt has no
// pages, a .docx has no stable ones), and page or paragraph anchors can be
// derived from them later without re-extracting anything.

// Matches CHUNK_WORDS in servicesTranscripts.js. Keeping book chunks the same
// size as lecture chunks is what makes their search results comparable — the
// reranker's preview window and the RRF fusion both assume one scale.
export const TEXT_CHUNK_WORDS = 500;

// A paragraph longer than this many times the target is split on word
// boundaries instead. Without it, one unbroken 8,000-word section (common in
// older books set without paragraph breaks) becomes a single chunk that is too
// large to embed and too coarse to search.
const OVERSIZE_FACTOR = 1.5;

const PARAGRAPH_BREAK = /\n{2,}/g;

const countWordsIn = (text) => {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
};

// Paragraph spans as [start, end) offsets into `text`, already tightened past
// surrounding whitespace so an offset always points at real content.
const splitParagraphs = (text) => {
  const spans = [];
  let cursor = 0;
  let match;
  PARAGRAPH_BREAK.lastIndex = 0;
  while ((match = PARAGRAPH_BREAK.exec(text)) !== null) {
    spans.push([cursor, match.index]);
    cursor = match.index + match[0].length;
  }
  spans.push([cursor, text.length]);

  const tightened = [];
  for (const [rawStart, rawEnd] of spans) {
    let start = rawStart;
    let end = rawEnd;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end > start) tightened.push({ start, end });
  }
  return tightened;
};

// Break one over-long paragraph into word-aligned pieces, preserving offsets.
const splitOversized = (text, span, targetWords) => {
  const body = text.slice(span.start, span.end);
  const words = [];
  const wordPattern = /\S+/g;
  let match;
  while ((match = wordPattern.exec(body)) !== null) {
    words.push([match.index, match.index + match[0].length]);
  }
  if (words.length === 0) return [span];

  const pieces = [];
  for (let i = 0; i < words.length; i += targetWords) {
    const slice = words.slice(i, i + targetWords);
    pieces.push({
      start: span.start + slice[0][0],
      end: span.start + slice[slice.length - 1][1],
    });
  }
  return pieces;
};

// Split extracted document text into chunks of roughly `targetWords` words,
// never cutting a paragraph unless the paragraph itself is too big.
//
// Returns [{ chunk_index, content, char_start, char_end }] — the same fields
// saveChunks writes for audio, minus the timestamps a document does not have.
export const chunkTextByParagraph = (text, targetWords = TEXT_CHUNK_WORDS) => {
  const source = String(text ?? "");
  if (!source.trim()) return [];

  // Paragraphs first, oversized ones broken down, so grouping below only ever
  // sees units that fit.
  const units = [];
  for (const span of splitParagraphs(source)) {
    const words = countWordsIn(source.slice(span.start, span.end));
    if (words > targetWords * OVERSIZE_FACTOR) {
      units.push(...splitOversized(source, span, targetWords));
    } else {
      units.push(span);
    }
  }

  // Accumulate whole units until adding the next one would overshoot. The span
  // between two grouped paragraphs is kept as-is, so the chunk's content still
  // contains the blank line that separated them.
  const grouped = [];
  let current = null;
  for (const unit of units) {
    const words = countWordsIn(source.slice(unit.start, unit.end));
    if (current === null) {
      current = { start: unit.start, end: unit.end, words };
    } else if (current.words + words > targetWords) {
      grouped.push(current);
      current = { start: unit.start, end: unit.end, words };
    } else {
      current.end = unit.end;
      current.words += words;
    }
  }
  if (current !== null) grouped.push(current);

  return grouped.map((chunk, index) => ({
    chunk_index: index,
    content: source.slice(chunk.start, chunk.end),
    char_start: chunk.start,
    char_end: chunk.end,
  }));
};
