-- The language a user reads the INTERFACE in (docs/i18n-plan.md).
--
-- On the server, not only in the browser, because the server writes to people
-- who are not in the browser: a session reminder, a finished transcript, a
-- password reset. Each of those mails is worded in this language.
--
-- Content never follows it — transcripts, summaries and names stay as written.
--
-- NOT NULL with a default, so every existing account reads Hebrew exactly as it
-- did, and no reader has to handle a missing value. The CHECK is the same list
-- as lib/languages.js (and the client's src/i18n/languages.js); a sixth
-- language is a new migration that widens it. No index: nothing looks a user up
-- by language — it is read off a row already found.
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale VARCHAR(8) NOT NULL DEFAULT 'he';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_locale_check;
ALTER TABLE users ADD CONSTRAINT users_locale_check
  CHECK (locale IN ('he', 'yi', 'en', 'fr', 'es'));
