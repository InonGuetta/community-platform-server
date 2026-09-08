-- The tag taxonomy, as a tree.
--
-- Tags arrived flat in 024 and free-form, because no vocabulary had been agreed.
-- One has now: seven roots, a mixture of two, three and four levels deep, 38
-- internal nodes and 224 leaves.
--
-- == Why uniqueness had to change ============================================
--
-- 024 made tags.name UNIQUE globally, which is right for a flat vocabulary and
-- WRONG for a tree. Five names in this taxonomy legitimately occur in two
-- places, and a global constraint silently collapses each pair into one tag:
--
--   shoftim       a parasha in Devarim, and a book of Neviim
--   lashon hara   a topic in Halacha, and one in Mussar
--   shalom bayit  in Mussar, and in the Jewish home
--   emuna         in Mussar, and in Emuna ve-Hashkafa
--   tefilla       in Mussar (and "hilchot tefilla" is a different tag again)
--
-- Collapsing them would file every shiur on the parasha under the book, and no
-- filter could tell them apart afterwards. Uniqueness is therefore per PARENT:
-- siblings must differ, cousins need not.
--
-- The table is empty when this runs (024 seeded nothing), so dropping the old
-- constraint costs no data.
--
-- == Why a tree and not a stored path string =================================
--
-- Filtering by a parent has to return everything beneath it: choosing "Torah"
-- must find a shiur tagged "Vayera". With a parent link that is one recursive
-- CTE. With a path string it is a LIKE over text, which cannot use an index and
-- breaks the moment a name contains the separator.

ALTER TABLE tags ADD COLUMN IF NOT EXISTS parent_id INT REFERENCES tags(id) ON DELETE CASCADE;

-- Distinguishes the agreed vocabulary from a tag somebody typed on an upload.
-- The picker offers the tree first and keeps free text working; without this
-- there is no way to tell the two apart afterwards.
ALTER TABLE tags ADD COLUMN IF NOT EXISTS is_seeded BOOLEAN NOT NULL DEFAULT FALSE;

-- Out with the global uniqueness, in with the per-parent kind.
ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_name_key;
DROP INDEX IF EXISTS idx_tags_name_lower;

-- Siblings must differ. LOWER() because Hebrew has no case but the English tags
-- somebody adds later do, and "Halacha"/"halacha" under one parent is one tag.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_sibling_name
  ON tags (parent_id, LOWER(name)) WHERE parent_id IS NOT NULL;

-- NULLs are distinct to a UNIQUE index, so the roots need their own partial one
-- or nothing stops two roots with the same name.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_root_name
  ON tags (LOWER(name)) WHERE parent_id IS NULL;

-- Walking down from a parent is the read the filter makes on every click.
CREATE INDEX IF NOT EXISTS idx_tags_parent ON tags(parent_id);

-- == The vocabulary ==========================================================
--
-- Written in the shape it was given in: a path, then the leaves under it. Kept
-- legible on purpose - this is the one part of the schema a non-programmer may
-- need to read and correct.
--
-- Idempotent by construction: every level is looked up before it is inserted, so
-- re-running adds nothing and changes nothing. db/migrate.js re-runs every file
-- on every invocation.
DO $$
DECLARE
  spec text[][] := ARRAY[
    ARRAY['תנ"ך /// תורה /// בראשית', 'בראשית, נח, לך לך, וירא, חיי שרה, תולדות, ויצא, וישלח, וישב, מקץ, ויגש, ויחי'],
    ARRAY['תנ"ך /// תורה /// שמות', 'שמות, וארא, בא, בשלח, יתרו, משפטים, תרומה, תצוה, כי תשא, ויקהל, פקודי'],
    ARRAY['תנ"ך /// תורה /// ויקרא', 'ויקרא, צו, שמיני, תזריע, מצורע, אחרי מות, קדושים, אמור, בהר, בחוקותי'],
    ARRAY['תנ"ך /// תורה /// במדבר', 'במדבר, נשא, בהעלותך, שלח לך, קרח, חוקת, בלק, פינחס, מטות, מסעי'],
    ARRAY['תנ"ך /// תורה /// דברים', 'דברים, ואתחנן, עקב, ראה, שופטים, כי תצא, כי תבוא, נצבים, וילך, האזינו, וזאת הברכה'],
    ARRAY['תנ"ך /// נביאים', 'יהושע, שופטים, שמואל א, שמואל ב, מלכים א, מלכים ב, ישעיהו, ירמיהו, יחזקאל, הושע, יואל, עמוס, עובדיה, יונה, מיכה, נחום, חבקוק, צפניה, חגי, זכריה, מלאכי'],
    ARRAY['תנ"ך /// כתובים', 'תהילים, משלי, איוב, שיר השירים, רות, איכה, קהלת, אסתר, דניאל, עזרא ונחמיה, דברי הימים'],
    ARRAY['משנה /// זרעים', 'ברכות, פאה, דמאי, כלאים, שביעית, תרומות, מעשרות, מעשר שני, חלה, ערלה, ביכורים'],
    ARRAY['משנה /// מועד', 'שבת, עירובין, פסחים, שקלים, יומא, סוכה, ביצה, ראש השנה, תענית, מגילה, מועד קטן, חגיגה'],
    ARRAY['משנה /// נשים', 'יבמות, כתובות, נדרים, נזיר, סוטה, גיטין, קידושין'],
    ARRAY['משנה /// נזיקין', 'בבא קמא, בבא מציעא, בבא בתרא, סנהדרין, מכות, שבועות, עדויות, עבודה זרה, אבות, הוריות'],
    ARRAY['משנה /// קדשים', 'זבחים, מנחות, חולין, בכורות, ערכין, תמורה, כריתות, מעילה, תמיד, מידות, קינים'],
    ARRAY['משנה /// טהרות', 'כלים, אהלות, נגעים, פרה, טהרות, מקוואות, נידה, מכשירין, זבים, טבול יום, ידיים, עוקצין'],
    ARRAY['הלכה /// טור ושולחן ערוך', 'אורח חיים, יורה דעה, אבן העזר, חושן משפט'],
    ARRAY['הלכה /// ספרי הלכה', 'רמב"ם (משנה תורה), משנה ברורה, קיצור שולחן ערוך, ערוך השולחן'],
    ARRAY['הלכה /// נושאים בהלכה', 'הלכות שבת, הלכות ברכות, הלכות תפילה, תפילין, ציצית, הלכות המועדים, אבלות, דיני ממונות, כשרות המטבח, ריבית, טהרת המשפחה, צניעות, שמיטה, לשון הרע'],
    ARRAY['מוסר וחסידות /// בין אדם למקום', 'אמונה ובטחון, תפילה, תשובה, יראת שמים, אהבת ה'''],
    ARRAY['מוסר וחסידות /// בין אדם לחברו', 'לשון הרע, כבוד הבריות, צדקה וחסד, שלום בית, ענווה ונתינה'],
    ARRAY['יהדות והשקפה /// אמונה והשקפה', 'אמונה ובטחון, שכר ועונש, השגחה פרטית'],
    ARRAY['יהדות והשקפה /// מעגל החיים', 'חתונה ונישואין, הולדה וברית, בר/בת מצווה, שכול ואבלות'],
    ARRAY['יהדות והשקפה /// הבית היהודי', 'שלום בית, חינוך ילדים, כלכלת הבית'],
    ARRAY['יהדות והשקפה /// חיזוק', 'חיזוק כללי, התמודדות באתגרים, מסרים קצרים'],
    ARRAY['קבלה וסוד', 'זוהר, תניא, עץ חיים, שער הגלגולים'],
    ARRAY['מעגל השנה (לפי חודשים) /// תשרי', 'ראש השנה, עשרת ימי תשובה, יום כיפור, סוכות, הושענא רבה, שמחת תורה'],
    ARRAY['מעגל השנה (לפי חודשים) /// חשוון–כסלו', 'חנוכה'],
    ARRAY['מעגל השנה (לפי חודשים) /// טבת–שבט', 'עשרה בטבת, שובבי"ם, ט"ו בשבט'],
    ARRAY['מעגל השנה (לפי חודשים) /// אדר', 'פרשת שקלים, פרשת זכור, פורים, פרשת פרה, פרשת החודש'],
    ARRAY['מעגל השנה (לפי חודשים) /// ניסן–אייר', 'פסח, ספירת העומר, ל"ג בעומר'],
    ARRAY['מעגל השנה (לפי חודשים) /// סיון', 'חג השבועות'],
    ARRAY['מעגל השנה (לפי חודשים) /// תמוז–אב', 'י"ז בתמוז, ימי בין המצרים, שבת חזון, תשעה באב, שבת נחמו, ט"ו באב'],
    ARRAY['מעגל השנה (לפי חודשים) /// אלול', 'חודש אלול וימי הרחמים']
  ];
  row_idx int;
  path_parts text[];
  part text;
  leaf text;
  parent int;
  found int;
BEGIN
  FOR row_idx IN 1 .. array_length(spec, 1) LOOP
    SELECT array_agg(btrim(x)) INTO path_parts
      FROM unnest(string_to_array(spec[row_idx][1], '///')) AS x
      WHERE btrim(x) <> '';

    parent := NULL;

    -- Walk the path, creating each level that is not there yet.
    FOREACH part IN ARRAY path_parts LOOP
      found := NULL;
      SELECT id INTO found FROM tags
       WHERE name = part AND (parent_id IS NOT DISTINCT FROM parent);
      IF found IS NULL THEN
        INSERT INTO tags (name, parent_id, is_seeded) VALUES (part, parent, TRUE)
        RETURNING id INTO found;
      END IF;
      parent := found;
    END LOOP;

    -- Then the leaves under the last level.
    FOREACH leaf IN ARRAY string_to_array(spec[row_idx][2], ',') LOOP
      leaf := btrim(leaf);
      IF leaf <> '' THEN
        found := NULL;
        SELECT id INTO found FROM tags WHERE name = leaf AND parent_id = parent;
        IF found IS NULL THEN
          INSERT INTO tags (name, parent_id, is_seeded) VALUES (leaf, parent, TRUE);
        END IF;
      END IF;
    END LOOP;
  END LOOP;
END $$;
