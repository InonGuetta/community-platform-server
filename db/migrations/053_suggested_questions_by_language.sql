-- The chat's three starting questions (PRD ASK-7, migration 045), in every
-- interface language rather than in Hebrew only.
--
-- They are chips the interface offers — "ask this" — so they follow the
-- language the reader chose, like the rest of the interface; the lesson, its
-- summary and the answers stay as written. The LLM worker now writes them once,
-- in one call, as an object keyed by language code:
--
--   {"he": ["…","…","…"], "yi": [...], "en": [...], "fr": [...], "es": [...]}
--
-- Every row written before held a plain array of Hebrew questions. They become
-- {"he": [...]}: the same questions for a Hebrew reader, and nothing in the
-- other languages — where the chat offers its fixed questions until
-- `npm run backfill:questions` writes this lesson's in all five.
UPDATE transcripts
   SET suggested_questions = jsonb_build_object('he', suggested_questions)
 WHERE jsonb_typeof(suggested_questions) = 'array';
