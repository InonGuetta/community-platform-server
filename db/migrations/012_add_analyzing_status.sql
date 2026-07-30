-- The transcription worker marked a transcript 'done' before handing it to the
-- LLM worker, so the summary and key points were written after the client had
-- already stopped polling — they only appeared on a manual refresh. 'analyzing'
-- names that gap, so the UI can keep watching until the AI step really finishes.
--
-- IF NOT EXISTS matters here: db/migrate.js re-runs every file on every
-- invocation, and ALTER TYPE would otherwise fail on the second run.
ALTER TYPE transcript_status ADD VALUE IF NOT EXISTS 'analyzing';
