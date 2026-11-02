-- When each part of a recording was said (PRD MOB-5, MOB-6): captions, and a
-- transcript that scrolls with the player.
--
-- transcript_chunks keep one start and one end per ~500 words — three or four
-- minutes of speech — which is enough to cite a passage and far too coarse to
-- caption one. Whisper reports a time for every phrase, and the worker threw
-- those away once the chunks were built. This keeps them, compactly: one
-- [word_index, seconds] pair per Whisper segment, plus a final pair for the end
-- — "the Nth word of the transcript is said at second T". The client
-- interpolates between pairs, and maps an edited transcript onto the same word
-- positions in proportion, so a lecturer's corrections still scroll in time.
--
-- Its own table, not a column on transcripts: that row is read with SELECT *
-- in several places and RETURNING * on every save, and ~20 KB of numbers would
-- ride along with each of them. One row per media item; the primary key is the
-- index on the foreign key.
--
-- Written by the transcription worker in the same transaction as the chunks, so
-- the two always describe the same words. Lessons transcribed before this have
-- no row, and the client falls back to the chunks' own times (estimated, and
-- labelled so). Re-running the pipeline fills it in.
--
-- ON DELETE CASCADE from media_items: timings have no meaning without their
-- recording, and nothing else references this table.

CREATE TABLE IF NOT EXISTS transcript_timings (
  media_id   INT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
  anchors    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
