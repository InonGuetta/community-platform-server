-- A bookmark placed on the PAGE ITSELF, in the original PDF.
--
-- ── Why a third kind of anchor ─────────────────────────────────────────────
--
-- Two exist. A recording is anchored to a second; a book, since 022 and 026, to
-- a range in the EXTRACTED text. Both work, and neither can express what a
-- reader does in the "מקור" tab: point at a line of the scan.
--
-- The extracted text is a translation of the document, and for a scanned sefer
-- it is a poor one — the OCR in this archive misreads freely. That does not
-- matter for a summary, and it matters enormously for "take me back to where I
-- was", because a bookmark whose only anchor is mistranscribed words can only be
-- found by searching for words that are wrong.
--
-- So this anchor skips the text entirely. It is a PAGE and a RECTANGLE on that
-- page: geometry, read from the document's own structure rather than from
-- anything a reader had to interpret. Bad OCR stops being a factor, rather than
-- being a bounded one.
--
-- ── Fractions, not pixels ──────────────────────────────────────────────────
--
-- x/y/w/h are fractions of the page, between 0 and 1. Pixels would be measured
-- at whatever zoom and window width the reader happened to have, and would point
-- somewhere else on every other screen — including their own phone. A fraction
-- is a property of the page, so it survives zoom, rotation of the viewport, a
-- different device, and a browser update.
--
-- REAL rather than DOUBLE PRECISION: about seven significant digits, against a
-- value the client rounds to five decimals. On a page 600 points wide that is
-- accurate to a hundredth of a point, which is far finer than a line of type.
--
-- ── page_number is reused, deliberately ────────────────────────────────────
--
-- 026 added it so a text bookmark could cite the page it was copied from. This
-- is the same fact — which page — so it gets the same column rather than a
-- second one meaning the same thing.
--
-- What differs is its ROLE. On a text bookmark the page is a citation and the
-- anchor is the chunk; here the page IS half of the anchor. The discriminator
-- between the two is the rectangle: only a page anchor has one.
--
-- ── What this kind does NOT have ───────────────────────────────────────────
--
-- No chunk_id, and that is a feature rather than an omission. A page anchor does
-- not depend on the extracted text, so re-running the pipeline cannot orphan it:
-- "הפק סיכום מחדש" deletes every chunk and this bookmark still points exactly
-- where it did. It is the only one of the three that survives that untouched.
--
-- IF NOT EXISTS / idempotent throughout: db/migrate.js re-runs every file on
-- every invocation.

-- 1. The rectangle. Four columns rather than one JSONB: they are four numbers of
--    one type, they are constrained below by the database itself, and a JSON
--    blob would put the validation in application code where nothing outside it
--    could rely on it.
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS rect_x REAL;
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS rect_y REAL;
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS rect_w REAL;
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS rect_h REAL;

-- 2. A rectangle is all four or none of them, and it has to describe a real
--    area on the page.
--
--    x + w is deliberately NOT constrained to 1. A selection legitimately runs
--    to the very edge of a page, and each fraction is rounded independently
--    before it is sent — so the sum can land a hair over one for a rectangle
--    that is perfectly correct. Constraining it would reject real marks to
--    prevent nothing: a rectangle that overflows the page simply draws clipped.
DO $$
BEGIN
  ALTER TABLE bookmarks
    ADD CONSTRAINT bookmarks_rect_is_whole
    CHECK (
      (rect_x IS NULL AND rect_y IS NULL AND rect_w IS NULL AND rect_h IS NULL)
      OR (
        rect_x IS NOT NULL AND rect_y IS NOT NULL AND rect_w IS NOT NULL AND rect_h IS NOT NULL
        AND rect_x >= 0 AND rect_x <= 1
        AND rect_y >= 0 AND rect_y <= 1
        AND rect_w >  0 AND rect_w <= 1
        AND rect_h >  0 AND rect_h <= 1
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 3. The anchor rule, widened to three kinds.
--
--    022's version admitted a timestamp or an offset. A page anchor is neither,
--    so it would have been refused by the very constraint that exists to stop a
--    bookmark pointing nowhere.
--
--    Dropped and re-added rather than added alongside: two CHECKs would both
--    have to pass, and the old one alone rejects every page anchor. The DROP
--    carries IF EXISTS so a database that never had it is unaffected.
ALTER TABLE bookmarks DROP CONSTRAINT IF EXISTS bookmarks_have_an_anchor;

DO $$
BEGIN
  ALTER TABLE bookmarks
    ADD CONSTRAINT bookmarks_have_an_anchor
    CHECK (
      timestamp_seconds IS NOT NULL
      OR char_position IS NOT NULL
      -- A page anchor. The rectangle is what makes it one: page_number alone is
      -- also set on text bookmarks, where it is a citation rather than a place.
      OR (page_number IS NOT NULL AND rect_x IS NOT NULL)
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 4. The read this adds: "the marks on the page I am looking at". The viewer
--    renders one page at a time out of five hundred, and asks this on every one.
--    Partial, because the column is NULL for every recording, every text
--    bookmark and every row that predates this file.
CREATE INDEX IF NOT EXISTS idx_bookmarks_page
  ON bookmarks(media_id, page_number)
  WHERE rect_x IS NOT NULL;
