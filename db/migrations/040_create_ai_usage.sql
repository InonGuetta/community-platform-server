-- What the platform spends on OpenAI, call by call (PRD ADM-1, NFR-3).
--
-- Until this nobody could say what a month of the platform cost — or which part
-- of it: transcribing a three-hour lecture, summarising a 400-page book and a
-- busy week of "דיון עם AI" are different bills, and the only record was the
-- invoice at the end of the month. And the only cap was the chat's daily
-- question quota (ASK-5): processing a large book was not limited at all.
--
-- Every OpenAI call the server makes is written here by ONE function —
-- services/servicesAiUsage.js → recordAiUsage — called by the metered client every module
-- uses (lib/openaiClient.js → meterOpenAI). The admin's cost screen reads it, and
-- so does the monthly cap (AI_MONTHLY_CAP_USD), which refuses NEW processing
-- once the month's spend reaches it.
--
-- ── What a row holds ────────────────────────────────────────────────────────
--
-- `purpose` is what the call was FOR (transcription, summary, hebrew_fix,
-- headings, embeddings, search, chat) — the line on the admin's screen. VARCHAR,
-- not an enum: a new purpose is a code change. `model` is what was billed.
--
-- The usage OpenAI reported — tokens in and out, or seconds of audio for
-- Whisper — and `cost_usd`, computed from those at write time with the price
-- table in services/servicesAiUsage.js. It is an ESTIMATE, stored rather than recomputed so
-- that a price change later does not rewrite what last month cost. NUMERIC, not
-- a float: these are small amounts summed many times.
--
-- No foreign keys: a usage row is an accounting fact, true after the lesson or
-- the user it served is deleted.
--
-- ── Index ───────────────────────────────────────────────────────────────────
--
-- Every read is "this month": the cap is checked before each new job, and the
-- screen sums the month by purpose. created_at is the whole of that.
--
-- Idempotent, like every migration here: db/migrate.js re-runs every file.

CREATE TABLE IF NOT EXISTS ai_usage (
  id             BIGSERIAL PRIMARY KEY,
  purpose        VARCHAR(40) NOT NULL,
  model          VARCHAR(60) NOT NULL,
  input_tokens   INT NOT NULL DEFAULT 0,
  output_tokens  INT NOT NULL DEFAULT 0,
  audio_seconds  NUMERIC(10, 2) NOT NULL DEFAULT 0,
  cost_usd       NUMERIC(12, 6) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage (created_at);
