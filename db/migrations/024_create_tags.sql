-- Tags: what KIND of content this is.
--
-- ── Why a table and not a text[] column ─────────────────────────────────────
--
-- An array column is one migration shorter and wrong for what this has to
-- become. Tags are meant to drive the filter and, later, the search — which
-- means the questions asked of them are "what tags exist" and "which items carry
-- this one", and both are index lookups on a join table and full scans on an
-- array. It also means a tag is a THING: it can be renamed once and be renamed
-- everywhere, which is the difference between a vocabulary and a pile of
-- strings that drift ("שיעור כללי", "שיעור-כללי", "שיעור  כללי").
--
-- ── Free text, for now ──────────────────────────────────────────────────────
--
-- No fixed vocabulary is seeded. The upload form offers the tags already in use
-- and accepts new ones, which is the same arrangement creator_name has and for
-- the same reason: nobody can write the right list up front, and a list that is
-- wrong is worse than none because it pushes people to file things under the
-- nearest wrong heading.
--
-- Turning this into a CONTROLLED vocabulary later costs one column
-- (`is_official BOOLEAN`) and a check in the service — the shape here does not
-- have to change for it.
--
-- Everything is IF NOT EXISTS because db/migrate.js re-runs every file on every
-- invocation.

CREATE TABLE IF NOT EXISTS tags (
  id SERIAL PRIMARY KEY,
  -- 60 is TAG_MAX in services/servicesTags.js, which rejects anything longer
  -- with a 400 before it reaches here. The two must move together: a column
  -- narrower than that check turns a clear message into a driver failure. Same
  -- pairing as playlists.title, and as media_items.creator_name.
  name VARCHAR(60) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  -- One tag per name, globally. Without this the same tag arrives twice from two
  -- uploads racing, and the filter then lists it twice with the items split
  -- between them — which looks like missing content and is nearly impossible to
  -- diagnose from the UI.
  --
  -- Case-insensitive, because "Halacha" and "halacha" are one tag to a person.
  -- Hebrew has no case, so this costs nothing for the tags that will actually be
  -- used and prevents the duplicate for the ones that are typed in English.
  UNIQUE (name)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_lower ON tags (LOWER(name));

CREATE TABLE IF NOT EXISTS media_tags (
  media_id INT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  tag_id INT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  -- CASCADE on both sides is right here and only here: the pairing is meaningless
  -- once either end is gone. The same reasoning as enrollments in migration 014.
  --
  -- The composite key IS the uniqueness constraint — an item cannot carry the
  -- same tag twice — and it is also the index for "which tags does this item
  -- have", which is the read every media card would otherwise pay for.
  PRIMARY KEY (media_id, tag_id)
);

-- The other direction: "which items carry this tag", which is the filter. A
-- composite primary key indexes its columns left to right only, so this one is
-- not free.
CREATE INDEX IF NOT EXISTS idx_media_tags_tag ON media_tags(tag_id);
