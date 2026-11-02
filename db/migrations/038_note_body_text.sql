-- A note's words, without its markup or its pictures (PRD NOTE-17).
--
-- ── Why ─────────────────────────────────────────────────────────────────────
--
-- The notebook's list used to come back with every note's whole body. A body is
-- HTML, and a pasted image lives inside it as base64 — up to 3MB each — so one
-- load of the notebook could be tens of megabytes, all parsed in the browser,
-- to draw a column of one-line previews. The list now carries a short preview
-- and the bodies are fetched for the notes actually being looked at.
--
-- Two things still need the words of EVERY note, without the markup: the
-- preview itself, and the notebook's search — which has to find a phrase in the
-- middle of a long note, not only in its first line. Both read this column.
--
-- ── A GENERATED column ──────────────────────────────────────────────────────
--
-- Computed by Postgres from `body` on every write, and filled in for every
-- existing row by this ALTER. One implementation of "the words of a note",
-- which no writer can forget to update and no backfill script has to repeat.
--
-- What it does, in order:
--   1. every tag becomes a space — so <p>a</p><p>b</p> reads "a b", and an
--      <img src="data:…"> (the base64 that made the list heavy) disappears whole;
--   2. the six entities the editor writes are decoded — &amp; LAST, so that an
--      escaped "&amp;lt;" becomes the text "&lt;" and never a "<";
--   3. runs of whitespace become one space, ends trimmed.
-- A body written before the editor existed is plain text with newlines, and
-- comes out as the same text on one line.
--
-- It is for reading and searching only. The client still renders and edits
-- the body, through the sanitizer (client utilities/noteHtml.js).
--
-- No index: every read of it is already narrowed to one user's notes
-- (idx_notes_user), and a substring search over a few hundred rows is cheap.
--
-- Idempotent, like every migration here: db/migrate.js re-runs every file.

ALTER TABLE notes ADD COLUMN IF NOT EXISTS body_text TEXT GENERATED ALWAYS AS (
  btrim(regexp_replace(
    replace(replace(replace(replace(replace(replace(
      regexp_replace(COALESCE(body, ''), '<[^>]*>', ' ', 'g'),
      '&nbsp;', ' '), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&'),
    '\s+', ' ', 'g'
  ))
) STORED;
