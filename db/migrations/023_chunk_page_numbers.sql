-- Which page of the original a chunk came from.
--
-- ── Why this is worth a column ──────────────────────────────────────────────
--
-- A character offset is the right ANCHOR — it is the only one every supported
-- format can produce, which is why 013 chose it for chunks and 022 for
-- bookmarks. It is a poor CITATION. Nobody says "see offset 41,208"; in learning
-- from a sefer the page is the unit people refer to, quote and look up.
--
-- So the two live side by side and do different jobs: char_start locates, and
-- page_number is what the reader prints beside it.
--
-- ── Why it is nullable, and stays nullable ─────────────────────────────────
--
-- Most documents have no pages. .txt has none; .docx has none until something
-- lays it out. Only a PDF can answer, and even then only when the extractor
-- could derive the boundaries safely — lib/textExtract.js returns pageOffsets
-- as null rather than guessing when its no-op assumption about
-- cleanExtractedText does not hold.
--
-- NULL therefore means "this text has no page", which is the truth, and is the
-- same shape and the same reasoning migration 013 used for start_time on a book
-- chunk. Storing a fake 1 would put every line of every .txt on "page 1" and
-- make the citation meaningless exactly where it is meant to be useful.
--
-- Audio and video chunks keep NULL here forever. They have a timeline instead.
--
-- IF NOT EXISTS because db/migrate.js re-runs every file on every invocation.
ALTER TABLE transcript_chunks ADD COLUMN IF NOT EXISTS page_number INT;

-- Reading a book by page: "show me what is on page 47". Partial, because the
-- column is NULL for every audio and video chunk in the archive and for every
-- document that has no pages — indexing those would be mostly dead weight, and
-- Postgres would skip the index anyway.
CREATE INDEX IF NOT EXISTS idx_chunks_page
  ON transcript_chunks(media_id, page_number)
  WHERE page_number IS NOT NULL;
