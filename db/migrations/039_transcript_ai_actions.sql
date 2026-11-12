-- "תיקון עברית" and "כותרות משנה" run on the LLM queue, with a status the page
-- polls (PRD PIPE-5, NFR-4).
--
-- ── Why ─────────────────────────────────────────────────────────────────────
--
-- Both ran INSIDE the HTTP request. The Hebrew correction sends one GPT call per
-- 2,500 words, one after another — a three-hour lecture is about eleven of them,
-- minutes of wall-clock — while the browser held a single request open and the
-- API server held the work. A proxy timeout, a closed laptop or a server
-- restart lost the result after it had been paid for. And "already running"
-- was guarded by a lock in ONE process's memory (lib/inFlight.js), which a
-- second server process could not see.
--
-- Now the request only CLAIMS the action and queues it; the LLM worker does it.
--
-- ── One status per action, on the transcript ────────────────────────────────
--
-- The same contract transcript_status already is for the pipeline: the
-- database says where the work stands, the page polls it, and nothing else is
-- the truth. Two actions, two sets of columns — they write different things
-- (edited_text; the headings, and sometimes the summary) and may run together.
--
--   *_status        NULL (never asked) → queued → running → done | error
--   *_error         the reason, when it is one the user can act on
--   *_requested_at  when it was last claimed. A claim older than
--                   AI_ACTION_STALE_MINUTES (servicesTranscripts) is treated
--                   as abandoned — a worker that died mid-job must not lock
--                   the button forever.
--
-- VARCHAR rather than an enum, like notifications.type: a fifth state is a
-- code change, not a migration. TIMESTAMPTZ, as every new time column since
-- 035 is.
--
-- Idempotent, like every migration here: db/migrate.js re-runs every file.

ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS hebrew_fix_status VARCHAR(20);
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS hebrew_fix_error TEXT;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS hebrew_fix_requested_at TIMESTAMPTZ;

ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS headings_status VARCHAR(20);
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS headings_error TEXT;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS headings_requested_at TIMESTAMPTZ;
