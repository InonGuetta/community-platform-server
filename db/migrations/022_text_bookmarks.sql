-- A bookmark in a book.
--
-- Until now a bookmark REQUIRED a moment in time: timestamp_seconds was NOT
-- NULL, which is exactly right for a recording and makes the feature impossible
-- for a document. A book has no timeline, and storing a fake 0 would put every
-- bookmark in every sefer at "00:00" in any query that orders or displays by it.
--
-- ── The anchor is a character offset, not a page ────────────────────────────
--
-- Migration 013 already made this decision for transcript_chunks and the reason
-- has not changed: a character offset into the extracted text is the only anchor
-- EVERY supported format can produce. .txt and .docx have no pages at all.
--
-- Page numbers were considered for this migration and deliberately left out. It
-- is not that they are unwanted — a citation by page is meaningful in a sefer —
-- it is that they are not free: lib/textExtract.js runs cleanExtractedText a
-- second time over the joined pages, and that pass is not length-preserving, so
-- page boundaries cannot be derived from the stored text by arithmetic. Getting
-- them right means restructuring the extractor to emit boundaries alongside the
-- text, which is its own change with its own tests, on the path this project
-- already treats carefully because of Hebrew PDFs. When that happens, the column
-- is `page_number` on transcript_chunks, and a bookmark reads it through the
-- chunk it falls in rather than storing a second copy.
--
-- IF NOT EXISTS / idempotent throughout: db/migrate.js re-runs every file on
-- every invocation.

-- 1. Time becomes optional.
--    It stays NOT NULL in spirit for audio and video — the player always has a
--    position — but NULL is the truthful value for a page of a book, and NULL is
--    what the UI branches on to decide whether to render "12:34" or a snippet.
ALTER TABLE bookmarks ALTER COLUMN timestamp_seconds DROP NOT NULL;

-- 2. The document anchor: a character offset into the extracted text, which is
--    the same coordinate space transcript_chunks.char_start already lives in.
--    That is what lets a bookmark be resolved to the chunk that contains it with
--    a plain BETWEEN, rather than needing its own copy of the surrounding text.
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS char_position INT;

-- 3. A bookmark that anchors to NOTHING is not a bookmark.
--
--    With both columns nullable, a request that omits them both would insert a
--    row pointing nowhere — visible in the list, impossible to jump to, and
--    impossible to distinguish from a real bookmark afterwards. The service
--    rejects that with a 400; this is the guarantee underneath, for every path
--    that is not the service.
--
--    Wrapped in a DO block because ADD CONSTRAINT has no IF NOT EXISTS: on a
--    re-run Postgres raises duplicate_object (42710), which db/migrate.js does
--    skip — but only for the whole statement, and the ALTERs above must still
--    run. Catching it here keeps the file re-runnable statement by statement.
DO $$
BEGIN
  ALTER TABLE bookmarks
    ADD CONSTRAINT bookmarks_have_an_anchor
    CHECK (timestamp_seconds IS NOT NULL OR char_position IS NOT NULL);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- The read this adds: "the bookmarks in this book, in reading order". The
-- existing idx_bookmarks_user_media covers finding them; this covers ordering
-- them without a sort, which is what the reader scrolls through.
CREATE INDEX IF NOT EXISTS idx_bookmarks_char
  ON bookmarks(media_id, char_position)
  WHERE char_position IS NOT NULL;
