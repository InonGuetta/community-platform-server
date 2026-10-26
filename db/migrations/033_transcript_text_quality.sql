-- How much of a book's extracted text is readable, 0–100 (lib/textQuality.js).
--
-- A PDF can carry a text layer that is mostly broken OCR — a multi-column page
-- read across its columns. Extraction succeeds, the summary and the embeddings
-- are built, and the search and the "דיון עם AI" chat then cover only the part
-- that reads. Nothing said so. This is measured once, by the LLM worker when it
-- extracts the text, and the book's page warns from it (below 80).
--
-- NULL means "not measured", and stays NULL for audio and video: a Whisper
-- transcript is generated text, not OCR, and is readable by construction. A
-- book processed before this column existed is NULL until
-- `npm run backfill:text-quality` measures it from its stored chunks.
--
-- A warning, never a refusal: a book that is two-thirds broken is still
-- one-third useful, and the lecturer can upload a better scan.
--
-- ADD COLUMN IF NOT EXISTS carries the CHECK with it, so a re-run skips both.
ALTER TABLE transcripts
  ADD COLUMN IF NOT EXISTS text_quality SMALLINT
    CHECK (text_quality IS NULL OR text_quality BETWEEN 0 AND 100);
