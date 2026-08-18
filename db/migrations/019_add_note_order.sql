-- The notebook becomes a hand-ordered document rather than a feed.
--
-- Notes were listed by updated_at DESC, which is a sensible default and a bad
-- final answer: it means editing a typo in the oldest note throws it to the top
-- of the notebook, and it gives the user no way to say "this chapter comes
-- first". sort_order is the order the USER put them in, and nothing but an
-- explicit reorder changes it — in particular saving a note does not, which is
-- the whole point.
--
-- Ascending, so "first in the notebook" is the smallest number. That is what
-- lets a new note be placed at the top with MIN(sort_order) - 1 instead of
-- renumbering every row the user already has.
ALTER TABLE notes ADD COLUMN sort_order INT NOT NULL DEFAULT 0;

-- Existing notebooks keep the order their owner is already looking at: the
-- order the list has always been rendered in. Without this every note starts at
-- 0 and the first reorder would appear to shuffle the notebook at random.
UPDATE notes SET sort_order = ranked.position
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY updated_at DESC, id DESC) AS position
  FROM notes
) AS ranked
WHERE notes.id = ranked.id;

-- The list query is (user_id, sort_order) and nothing else, so this is the
-- index it reads. idx_notes_user stays: it still serves the ownership checks in
-- update and delete.
CREATE INDEX idx_notes_user_order ON notes(user_id, sort_order);
