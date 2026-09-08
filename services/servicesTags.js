// @ts-check
import { pool } from "../db/pool.js";
import { badRequest } from "../lib/AppError.js";
import { visibleMediaSql } from "../lib/permissions.js";

// Tags — what kind of content an item is.
//
// A tag is created by being used. There is no "create a tag" screen and no fixed
// vocabulary: the upload form offers what is already in use and accepts anything
// new, which is the same arrangement creator_name has. See migration 024 for why
// that is deliberate and what turning it into a controlled vocabulary would cost.

// Matches VARCHAR(60) in 024_create_tags.sql. SQL cannot import this, so the
// migration carries a comment naming this constant — a column narrower than the
// check turns a clear 400 into a driver error.
const TAG_MAX = 60;

// How many tags one item may carry. Not a storage limit — a legibility one: a
// card showing fifteen tags shows nothing, and an item tagged with everything is
// findable under nothing.
const TAGS_PER_ITEM_MAX = 8;

// Collapsing internal whitespace matters as much as trimming: "שיעור  כללי" and
// "שיעור כללי" are one tag to a person and two to a UNIQUE index, and once both
// exist the filter lists them separately with the items split between them.
const cleanTag = (value) => {
  const trimmed = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!trimmed) return null;
  if (trimmed.length > TAG_MAX) {
    throw badRequest(`תגית יכולה להכיל עד ${TAG_MAX} תווים`);
  }
  return trimmed;
};

/**
 * Normalises a list of tag names: trimmed, de-duplicated case-insensitively,
 * capped. Returns [] for anything that is not a list.
 *
 * Exported for the tests, which is the level this logic is worth pinning at —
 * everything below it is a query.
 */
export const cleanTagNames = (names) => {
  if (!Array.isArray(names)) return [];
  const seen = new Map();
  for (const raw of names) {
    const name = cleanTag(raw);
    if (!name) continue;
    // First spelling wins, so the tag keeps the casing whoever typed it first
    // chose rather than flickering between uploads.
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
  }
  const list = [...seen.values()];
  if (list.length > TAGS_PER_ITEM_MAX) {
    throw badRequest(`ניתן לשייך עד ${TAGS_PER_ITEM_MAX} תגיות לפריט`);
  }
  return list;
};

/**
 * Turns names into ids, creating the ones that do not exist yet.
 *
 * ON CONFLICT rather than a SELECT-then-INSERT: two uploads naming the same new
 * tag at the same moment would otherwise both find nothing and both insert, and
 * one would fail on the unique index. The DO UPDATE (rather than DO NOTHING) is
 * what makes RETURNING give back a row in the conflict case too — DO NOTHING
 * returns nothing for rows it skipped, which is the classic way this pattern
 * silently loses the tags that already existed.
 */
// A free-text tag lands at the ROOT of the tree, beside the seven agreed
// headings and marked is_seeded = false. It is deliberately not guessed into a
// branch: putting "שיעור לנוער" under one of them would be an invention, and the
// taxonomy is what the vocabulary means.
//
// The conflict target is the PARTIAL root index from migration 025, not the
// global unique that 024 had and 025 dropped — names repeat across branches now,
// so only the roots are globally unique. Inferring the wrong index here fails at
// runtime with "no unique or exclusion constraint matching".
const upsertRootTags = async (client, names) => {
  if (names.length === 0) return [];
  const values = names.map((_, i) => `($${i + 1}, NULL, FALSE)`).join(", ");
  const { rows } = await client.query(
    `INSERT INTO tags (name, parent_id, is_seeded) VALUES ${values}
     ON CONFLICT (LOWER(name)) WHERE parent_id IS NULL
     DO UPDATE SET name = tags.name
     RETURNING id`,
    names
  );
  return rows.map((r) => r.id);
};

/**
 * Replaces an item's tags with exactly this set.
 *
 * Replace, not add: the caller is an edit form that shows the current tags, so
 * what it sends IS the answer. Adding would make removing a tag impossible
 * through the only screen that offers them.
 */
/**
 * The two lists, checked and cleaned, without writing anything.
 *
 * Separated from the write so a caller can find out that a selection is
 * unacceptable BEFORE it creates the row the tags would hang off. Upload needs
 * exactly that: it stores a file and inserts a media row first, so a 400 raised
 * at tagging time arrives after the expensive, half-irreversible part is done.
 *
 * Two ways in, because there are two kinds of choice. A pick from the taxonomy
 * is an ID — it has to be, since five names occur in two branches and a name
 * could not say which was meant. Anything typed is a NAME, and becomes a
 * root-level tag.
 */
export const cleanTagSelection = ({ ids = [], names = [] } = {}) => {
  const chosenIds = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))];
  const clean = cleanTagNames(names);

  if (chosenIds.length + clean.length > TAGS_PER_ITEM_MAX) {
    throw badRequest(`ניתן לשייך עד ${TAGS_PER_ITEM_MAX} תגיות לפריט`);
  }
  return { ids: chosenIds, names: clean };
};

export const setMediaTags = async (mediaId, selection = {}) => {
  const { ids: chosenIds, names: clean } = cleanTagSelection(selection);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM media_tags WHERE media_id=$1", [mediaId]);

    const ids2 = await upsertRootTags(client, clean);
    const allIds = [...new Set([...chosenIds, ...ids2])];
    if (allIds.length > 0) {
      const values = allIds.map((_, i) => `($1, $${i + 2})`).join(", ");
      await client.query(
        `INSERT INTO media_tags (media_id, tag_id) VALUES ${values}
         ON CONFLICT DO NOTHING`,
        [mediaId, ...allIds]
      );
    }

    await client.query("COMMIT");
    return allIds;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Every tag in use, with how many items carry it.
 *
 * The count is what lets the filter put the useful tags first and lets an admin
 * see which ones were typed once by mistake. Tags with no items are excluded —
 * they can only exist transiently, between an item losing its last tag and
 * nothing cleaning up, and offering them as a filter that returns nothing is
 * worse than not offering them.
 */
export const getTagsInUse = async () => {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, COUNT(mt.media_id)::int AS media_count
     FROM tags t
     JOIN media_tags mt ON mt.tag_id = t.id
     GROUP BY t.id, t.name
     ORDER BY media_count DESC, t.name`
  );
  return rows;
};

/**
 * The whole taxonomy, flat, with each node's parent — the client assembles the
 * tree from it.
 *
 * Sent whole rather than a level at a time, and that is a deliberate trade: the
 * vocabulary is a few hundred rows, so it is one small request, and the drill-
 * down then costs nothing per click. Fetching per level would put a round trip
 * between every tap of a filter, which is the interaction this is for.
 *
 * `media_count` is the item count for the node's ENTIRE SUBTREE, not just items
 * tagged with the node itself. Almost nothing is tagged "תורה" directly, so a
 * direct count would read 0 beside a branch holding a hundred shiurim — and a
 * count of zero is read as "nothing here", which is the opposite of the truth.
 *
 * ── The count is what the VIEWER can see ────────────────────────────────────
 *
 * It used to count every tagged row in the table, which made it a number nobody
 * could act on: a student saw "7" beside a branch, clicked it, and got three
 * items, because the other four were drafts or belonged to a course they are not
 * enrolled in. A count that does not match what the filter returns is worse than
 * no count — it reads as missing content, which is the one thing a filter must
 * never look like.
 *
 * It takes the same two-dimensional scope as the listing and applies the same
 * predicate, from the same place, so the two cannot drift.
 */
/**
 * @param {{ visibleCourses?: number[]|null, visibleDrafts?: number[]|null }} [scope]
 */
export const getTagTree = async (scope = {}) => {
  const { visibleCourses, visibleDrafts } = scope;
  const { rows } = await pool.query(
    `WITH RECURSIVE descendants AS (
       SELECT id AS root_id, id AS tag_id FROM tags
       UNION ALL
       SELECT d.root_id, t.id FROM tags t JOIN descendants d ON t.parent_id = d.tag_id
     ),
     visible AS (
       SELECT mt.tag_id, mt.media_id
       FROM media_tags mt
       JOIN media_items m ON m.id = mt.media_id
       WHERE ${visibleMediaSql("$1", "m", "$2")}
     ),
     counts AS (
       SELECT d.root_id, COUNT(DISTINCT v.media_id)::int AS media_count
       FROM descendants d
       LEFT JOIN visible v ON v.tag_id = d.tag_id
       GROUP BY d.root_id
     )
     SELECT t.id, t.name, t.parent_id, t.is_seeded,
            COALESCE(c.media_count, 0) AS media_count
     FROM tags t
     LEFT JOIN counts c ON c.root_id = t.id
     ORDER BY t.parent_id NULLS FIRST, t.id`,
    // The same fail-closed rule as the listing: an ABSENT scope means nobody's
    // courses and nobody's drafts, never everybody's.
    [visibleCourses === undefined ? [] : visibleCourses, visibleDrafts === undefined ? [] : visibleDrafts]
  );
  return rows;
};
