-- "מעגל השנה" becomes a root with two ways in: by month, and by Shabbat.
--
-- 025 seeded the year cycle as a single root, "מעגל השנה (לפי חודשים)". It is
-- now one of two children of a new root "מעגל השנה", renamed to
-- "מעגל השנה לפי חודשים" and keeping everything beneath it; its sibling
-- "מעגל השנה לפי שבתות" holds the special Shabbatot.
--
-- The existing node is MOVED, not copied: its id is what media_tags points at,
-- so every shiur already filed under a month stays filed under it, and the
-- filter on the new root finds them through the recursive walk.
--
-- == Why the cleanup step at the end =========================================
--
-- db/migrate.js re-runs every file on every invocation, and 025 looks its root
-- up by name. Once this file has renamed that root, the next run of 025 finds
-- no "מעגל השנה (לפי חודשים)" and seeds a fresh, empty copy of the whole
-- month tree as a root again - a second year cycle in the filter. 025 cannot be
-- edited, so this file removes that copy each time it appears. It is only ever
-- seconds old (025 and this file run in the same invocation), so nothing can be
-- tagged with it; the media_tags check is there so that an assumption, if it is
-- ever wrong, ends in a warning rather than in deleted tagging.
DO $$
DECLARE
  shabbatot text := 'שבת שובה, שבת חול המועד סוכות, שבת בראשית, שבת חנוכה, שבת שירה, '
                 || 'שבת שקלים, שבת זכור, שבת פרה, שבת החודש, שבת הגדול, '
                 || 'שבת חול המועד פסח, שבת חזון, שבת נחמו, שבת מברכים, '
                 || 'שבת ראש חודש, שבת מחר חודש, שבת הפסקה';
  root_id int;
  months_id int;
  old_id int;
  shabbat_id int;
  leaf text;
  found int;
BEGIN
  SELECT id INTO root_id FROM tags WHERE parent_id IS NULL AND name = 'מעגל השנה';
  IF root_id IS NULL THEN
    INSERT INTO tags (name, parent_id, is_seeded) VALUES ('מעגל השנה', NULL, TRUE)
    RETURNING id INTO root_id;
  END IF;

  SELECT id INTO months_id FROM tags WHERE parent_id = root_id AND name = 'מעגל השנה לפי חודשים';
  SELECT id INTO old_id FROM tags WHERE parent_id IS NULL AND name = 'מעגל השנה (לפי חודשים)';

  IF months_id IS NULL AND old_id IS NOT NULL THEN
    -- First run: move the existing tree, children and tagging included.
    UPDATE tags SET parent_id = root_id, name = 'מעגל השנה לפי חודשים' WHERE id = old_id;
    months_id := old_id;
    old_id := NULL;
  ELSIF months_id IS NULL THEN
    INSERT INTO tags (name, parent_id, is_seeded) VALUES ('מעגל השנה לפי חודשים', root_id, TRUE)
    RETURNING id INTO months_id;
  END IF;

  -- Later runs: the copy 025 has just re-seeded. See the header.
  IF old_id IS NOT NULL THEN
    IF EXISTS (
      WITH RECURSIVE sub AS (
        SELECT id FROM tags WHERE id = old_id
        UNION ALL
        SELECT t.id FROM tags t JOIN sub ON t.parent_id = sub.id
      )
      SELECT 1 FROM media_tags WHERE tag_id IN (SELECT id FROM sub)
    ) THEN
      RAISE WARNING 'tag % "מעגל השנה (לפי חודשים)" has tagged media and was left in place', old_id;
    ELSE
      DELETE FROM tags WHERE id = old_id;
    END IF;
  END IF;

  SELECT id INTO shabbat_id FROM tags WHERE parent_id = root_id AND name = 'מעגל השנה לפי שבתות';
  IF shabbat_id IS NULL THEN
    INSERT INTO tags (name, parent_id, is_seeded) VALUES ('מעגל השנה לפי שבתות', root_id, TRUE)
    RETURNING id INTO shabbat_id;
  END IF;

  -- In the order of the year, which is the order the tree displays (by id).
  FOREACH leaf IN ARRAY string_to_array(shabbatot, ',') LOOP
    leaf := btrim(leaf);
    IF leaf <> '' THEN
      found := NULL;
      SELECT id INTO found FROM tags WHERE name = leaf AND parent_id = shabbat_id;
      IF found IS NULL THEN
        INSERT INTO tags (name, parent_id, is_seeded) VALUES (leaf, shabbat_id, TRUE);
      END IF;
    END IF;
  END LOOP;
END $$;
