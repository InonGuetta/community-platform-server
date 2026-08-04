-- Books (media_type='text') reuse transcripts + transcript_chunks rather than
-- getting a parallel model of their own. Everything valuable already hangs off
-- those two tables — the FTS GIN index (004), the pgvector embeddings and HNSW
-- index (010), the hybrid RRF search, the status/polling contract — and a second
-- model would mean a second copy of all of it. What a book does NOT have is a
-- timeline, so this migration makes the timeline optional and adds the anchor a
-- document can actually provide.
--
-- Every statement is idempotent: db/migrate.js re-runs every file on every
-- invocation (see 012's note), so anything that is not would fail on run two.

-- 1. Timestamps become optional.
--    They stay NOT NULL in spirit for audio/video — the transcription worker
--    always supplies them — but a page of a book has no start_time, and storing
--    a fake 0 there would put every book chunk at "00:00" in any query that
--    orders or displays by time. NULL says "this has no position in time",
--    which is the truth and is what the UI branches on.
ALTER TABLE transcript_chunks ALTER COLUMN start_time DROP NOT NULL;
ALTER TABLE transcript_chunks ALTER COLUMN end_time   DROP NOT NULL;

-- 2. The document anchor: character offsets into the extracted text.
--    Chosen over page numbers because it is the only anchor every supported
--    format can produce (.txt and .docx have no pages), and page/paragraph
--    positions can be derived from it later without re-extracting the file.
ALTER TABLE transcript_chunks ADD COLUMN IF NOT EXISTS char_start INT;
ALTER TABLE transcript_chunks ADD COLUMN IF NOT EXISTS char_end   INT;

-- 3. Why a run failed, in words the lecturer can act on.
--    status='error' alone cannot distinguish "this PDF is a scan, convert it"
--    from "OpenAI timed out, press the button again" — and those need opposite
--    responses from the user. Without this column the UI can only say something
--    went wrong, which is how a permanently-unprocessable file gets retried
--    forever.
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS error_message TEXT;
