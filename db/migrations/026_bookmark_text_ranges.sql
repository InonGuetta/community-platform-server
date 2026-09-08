-- A bookmark in a book stops being a POINT and becomes a PASSAGE.
--
-- Migration 022 gave a bookmark a character offset so a sefer could hold one at
-- all, and that was the right first step: it made the feature possible. What it
-- anchors, though, is a single character — in practice the first character of a
-- ~500-word chunk, because that is the only place the reader could offer a
-- button. The user marks a paragraph and the system remembers a chunk.
--
-- What the reader is growing (see docs/TEXT_BOOKMARKS_PLAN.md) is a marker the
-- user drags across the text, exactly as they would with a highlighter on paper.
-- That gesture produces a RANGE, and a range needs an end.
--
-- ── Four columns, and why each is not derivable from the others ─────────────
--
--   char_end     where the marked passage stops. Without it a highlight cannot
--                be drawn back onto the page after a reload — only guessed at.
--
--   chunk_id     which chunk the passage lives in. char_position alone can find
--                it with a BETWEEN, but only while the chunks are the same ones
--                the offset was taken against; see the ON DELETE note below,
--                which is what turns this column into the truth-teller about
--                whether the anchor still means anything.
--
--   quoted_text  the words that were marked, copied at the moment of marking.
--                This is what the side list SHOWS — "(ללא הערה)" beside every
--                bookmark in a sefer is a list nobody can read — and it is the
--                only record of what the user meant that survives the text being
--                re-extracted underneath it.
--
--   page_number  the citation. Derived from the chunk AT WRITE TIME rather than
--                read through the join, for the same reason quoted_text is
--                copied: after a re-extraction the chunk may be gone, and "עמ׳
--                47" is precisely the thing a person needs in order to find the
--                passage again by hand.
--
-- ── ON DELETE SET NULL, and never CASCADE ──────────────────────────────────
--
-- This is the single most consequential line in the file.
--
-- services/transcripts/chunks.js → writeChunks DELETEs every chunk of a media
-- item and re-inserts them, on every run of the pipeline. A lecturer pressing
-- "הפק סיכום מחדש" therefore deletes every transcript_chunks row for that book.
-- With ON DELETE CASCADE that press would silently delete every bookmark every
-- reader ever left in it — an irreversible loss of other people's work, caused
-- by a button whose label says nothing of the kind.
--
-- SET NULL is not a lesser evil here, it is the intended mechanism. It makes the
-- bookmark survive with its note, its quoted text and its page, and marks it —
-- by a NULL chunk_id — as no longer resolvable to a place on the page. That is
-- exactly the behaviour the client already documents as correct, in
-- bookAnchors.test.js: "the bookmark is still listed, it just cannot be jumped
-- to".
--
-- ── What the CHECK does and does not promise ───────────────────────────────
--
-- It enforces ORDERING and NO-ORPHAN-END: an end never appears without a start,
-- and never before it. It deliberately does NOT require char_end to be present
-- whenever char_position is.
--
-- Two kinds of row would fail such a constraint, and both are legitimate:
--   * every bookmark written by 022's reader, which is a point anchor by design
--     and still means "the paragraph starting here";
--   * a bookmark whose passage was re-extracted away, which SET NULL above
--     exists to preserve rather than to invalidate.
--
-- A constraint has to describe every row that exists, not the shape the newest
-- writer happens to produce. Completeness of a NEW range is enforced one layer
-- up, in servicesBookmarks — the same division of labour 022 chose, and stated:
-- "The service rejects that with a 400; this is the guarantee underneath, for
-- every path that is not the service."
--
-- The length of quoted_text is capped in the controller and deliberately NOT
-- repeated here. A number written in two places with nothing comparing them is
-- the cross-file pair this codebase keeps being bitten by; one authority is
-- worth more than a second copy that can drift.
--
-- IF NOT EXISTS / idempotent throughout: db/migrate.js re-runs every file on
-- every invocation.

-- 1. The end of the marked passage.
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS char_end INT;

-- 2. The chunk the passage sits in. SET NULL — see the note above; CASCADE here
--    would make "הפק סיכום מחדש" a bulk delete of other people's bookmarks.
ALTER TABLE bookmarks
  ADD COLUMN IF NOT EXISTS chunk_id INT REFERENCES transcript_chunks(id) ON DELETE SET NULL;

-- 3. The words that were marked, and the page they were on.
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS quoted_text TEXT;
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS page_number INT;

-- 4. Ordering, and no end without a start.
--
--    Wrapped in a DO block because ADD CONSTRAINT has no IF NOT EXISTS: on a
--    re-run Postgres raises duplicate_object (42710), which db/migrate.js does
--    skip — but only for the whole statement, and everything after it in this
--    file must still run. Same pattern, and the same reason, as 022.
DO $$
BEGIN
  ALTER TABLE bookmarks
    ADD CONSTRAINT bookmarks_range_is_ordered
    CHECK (char_end IS NULL OR (char_position IS NOT NULL AND char_end >= char_position));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 5. An index on the foreign key, as every foreign key in this schema has.
--    Partial, because chunk_id is NULL for every bookmark on a recording and for
--    every text bookmark whose chunk has since been re-extracted — indexing
--    those would be dead weight Postgres would skip anyway. Same shape and the
--    same reasoning as idx_bookmarks_char in 022 and idx_chunks_page in 023.
CREATE INDEX IF NOT EXISTS idx_bookmarks_chunk
  ON bookmarks(chunk_id)
  WHERE chunk_id IS NOT NULL;

-- 6. Backfill: give the bookmarks written by 022's reader their chunk and their
--    page.
--
--    Only these two, and that is a deliberate line. chunk_id and page_number are
--    DERIVED — the containing chunk is a fact about data that is already here,
--    and computing it now costs nothing and makes every existing bookmark
--    citable. char_end and quoted_text would be INVENTED: nobody marked a
--    passage, so there is no passage to record, and writing one would make a
--    point anchor indistinguishable from a range somebody actually dragged.
--
--    A NULL char_end therefore has one meaning everywhere, old rows and new:
--    "this marks the paragraph beginning here", which is what the existing
--    reader means by it and what it already renders.
--
--    Idempotent by the chunk_id IS NULL guard: the second run matches nothing.
--    Chunks with a NULL char_start are audio and video, which no text bookmark
--    can point into — excluded so a bookmark can never be joined to one.
UPDATE bookmarks b
SET chunk_id    = c.id,
    page_number = c.page_number
FROM transcript_chunks c
WHERE b.chunk_id IS NULL
  AND b.char_position IS NOT NULL
  AND c.media_id = b.media_id
  AND c.char_start IS NOT NULL
  AND c.char_end IS NOT NULL
  AND b.char_position BETWEEN c.char_start AND c.char_end;
