// @ts-check
import { pool } from "../db/pool.js";
import { badRequest, conflict, notFound, ERROR_CODES } from "../lib/AppError.js";
import { visibleMediaSql } from "../lib/permissions.js";

// Tags — what kind of content an item is.
//
// The vocabulary is a tree (migration 025), and it grows only with an admin's
// approval. A lecturer who needs a tag that is not there PROPOSES it, with the
// place in the tree it belongs (proposeTag); the items it was proposed on get
// it the moment an admin approves (approveTagProposal). It used to be that
// anything typed became a root tag on the spot, which is how a controlled
// vocabulary fills with near-duplicates nobody chose. See migration 029.

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

// Names that already exist as root tags, and nothing else. What a non-admin's
// typed names resolve through: a tag somebody typed before approvals existed
// is still theirs to pick, but a NEW one goes through proposeTag.
const existingRootTags = async (client, names) => {
  if (names.length === 0) return [];
  const { rows } = await client.query(
    `SELECT id, LOWER(name) AS key FROM tags
     WHERE parent_id IS NULL AND LOWER(name) = ANY($1::text[])`,
    [names.map((n) => n.toLowerCase())]
  );
  const found = new Set(rows.map((r) => r.key));
  const missing = names.filter((n) => !found.has(n.toLowerCase()));
  if (missing.length > 0) {
    throw badRequest(`תגית חדשה נכנסת למערכת רק באישור מנהל — יש להציע אותה דרך "הוסף תגית": ${missing.join(", ")}`);
  }
  return rows.map((r) => r.id);
};

/**
 * @param {number|string} mediaId
 * @param {{ ids?: number[], names?: string[] }} [selection]
 * @param {{ canCreate?: boolean }} [options] canCreate — may a typed name that
 *   does not exist yet become a tag? Only an admin's may: everybody else's new
 *   tag waits for approval (proposeTag). Defaults to NO, so a caller that
 *   forgets to decide cannot open the vocabulary.
 */
export const setMediaTags = async (mediaId, selection = {}, { canCreate = false } = {}) => {
  const { ids: chosenIds, names: clean } = cleanTagSelection(selection);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM media_tags WHERE media_id=$1", [mediaId]);

    const ids2 = canCreate ? await upsertRootTags(client, clean) : await existingRootTags(client, clean);
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

// ── Proposals: a new tag waits for an admin ─────────────────────────────────
//
// Migration 029 says why a proposal is not a tag with a status column. The
// short version: every read of `tags` would have to remember to skip it.

// The same BEGIN/COMMIT/ROLLBACK/release every write below needs.
const inTransaction = async (work) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// A parent id from a request: absent/null means "a new root heading", anything
// else must be a tag that exists. Checked rather than left to the foreign key,
// whose failure would reach the caller as a 500.
const resolveParentId = async (db, parentId) => {
  if (parentId === null || parentId === undefined || parentId === "") return null;
  const id = Number(parentId);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("תגית האב אינה תקינה");
  const { rows } = await db.query("SELECT id FROM tags WHERE id=$1", [id]);
  if (rows.length === 0) throw badRequest("Parent tag not found", ERROR_CODES.TAG_PARENT_NOT_FOUND);
  return id;
};

const requireTagName = (value) => {
  const name = cleanTag(value);
  if (!name) throw badRequest("יש להזין שם לתגית");
  return name;
};

// The tag already standing at this place, if any. Siblings are unique by
// LOWER(name) (025), so this is at most one row.
const tagAt = async (db, parentId, name) => {
  const { rows } = await db.query(
    "SELECT id FROM tags WHERE parent_id IS NOT DISTINCT FROM $1 AND LOWER(name) = LOWER($2)",
    [parentId, name]
  );
  return rows[0]?.id ?? null;
};

// Creates the tag at this place, or returns the one already there — so an
// approval can never produce a sibling that differs only in case. is_seeded
// TRUE: an approved tag is part of the agreed vocabulary, not a free-typed one,
// and the filter draws it that way.
const ensureTag = async (db, parentId, name) => {
  const existing = await tagAt(db, parentId, name);
  if (existing) return existing;
  const { rows } = await db.query(
    "INSERT INTO tags (name, parent_id, is_seeded) VALUES ($1, $2, TRUE) RETURNING id",
    [name, parentId]
  );
  return rows[0].id;
};

// ON CONFLICT because an item may already carry the tag — an admin approving a
// tag that somebody meanwhile picked by hand.
const attachTag = async (db, tagId, mediaIds) => {
  if (mediaIds.length === 0) return;
  await db.query(
    `INSERT INTO media_tags (media_id, tag_id)
     SELECT m, $1 FROM unnest($2::int[]) AS m
     ON CONFLICT DO NOTHING`,
    [tagId, mediaIds]
  );
};

/**
 * A new tag, asked for on one item.
 *
 * An admin's request IS an approval, so it creates the tag and tags the item at
 * once — asking them to approve their own proposal on another screen would be
 * ceremony. Everybody else's waits: the proposal is stored, the item is linked
 * to it, and approveTagProposal does the rest.
 *
 * Two lecturers asking for the same name in the same place share one proposal
 * (the partial unique index in 029), so the admin decides once and both items
 * get the tag.
 *
 * @param {{ mediaId: number|string, name: unknown, parentId?: unknown, user: { id: number, role: string } }} args
 */
export const proposeTag = ({ mediaId, name: rawName, parentId: rawParentId, user }) => {
  const name = requireTagName(rawName);
  return inTransaction(async (client) => {
    const parentId = await resolveParentId(client, rawParentId);

    if (await tagAt(client, parentId, name)) {
      throw conflict("A tag with this name already exists under this parent", ERROR_CODES.TAG_EXISTS);
    }

    if (user.role === "admin") {
      const tagId = await ensureTag(client, parentId, name);
      await attachTag(client, tagId, [Number(mediaId)]);
      // Recorded all the same, already decided: the log of who added what to
      // the vocabulary should not have a hole where the admins' additions are.
      await client.query(
        `INSERT INTO tag_proposals (name, parent_id, proposed_by, status, decided_by, decided_at, tag_id)
         VALUES ($1, $2, $3, 'approved', $3, NOW(), $4)`,
        [name, parentId, user.id, tagId]
      );
      return { status: "approved", tag_id: tagId, name, parent_id: parentId };
    }

    // The per-item cap counts what is waiting too. Otherwise an item at eight
    // tags could collect proposals and pass the cap the day they are approved.
    const { rows: [{ count }] } = await client.query(
      `SELECT (SELECT COUNT(*) FROM media_tags WHERE media_id = $1)
            + (SELECT COUNT(*) FROM tag_proposal_media pm
                 JOIN tag_proposals p ON p.id = pm.proposal_id
                WHERE pm.media_id = $1 AND p.status = 'pending') AS count`,
      [mediaId]
    );
    if (Number(count) >= TAGS_PER_ITEM_MAX) {
      throw badRequest(`ניתן לשייך עד ${TAGS_PER_ITEM_MAX} תגיות לפריט, כולל תגיות שממתינות לאישור`);
    }

    // DO UPDATE rather than DO NOTHING so RETURNING gives back the existing
    // proposal too — the same reason upsertRootTags does it.
    const { rows: [proposal] } = await client.query(
      `INSERT INTO tag_proposals (name, parent_id, proposed_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (COALESCE(parent_id, 0), LOWER(name)) WHERE status = 'pending'
       DO UPDATE SET name = tag_proposals.name
       RETURNING id, name, parent_id, status, created_at`,
      [name, parentId, user.id]
    );
    await client.query(
      "INSERT INTO tag_proposal_media (proposal_id, media_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [proposal.id, mediaId]
    );
    return proposal;
  });
};

/** What is still waiting for approval on this item — shown in its tagging dialog. */
export const getPendingProposalsForMedia = async (mediaId) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.parent_id, p.status, p.created_at
     FROM tag_proposals p
     JOIN tag_proposal_media pm ON pm.proposal_id = p.id
     WHERE pm.media_id = $1 AND p.status = 'pending'
     ORDER BY p.created_at, p.id`,
    [mediaId]
  );
  return rows;
};

/**
 * Takes this item's claim off a pending proposal — the lecturer changed their
 * mind, or mistyped. The proposal itself goes too once no item waits on it: an
 * admin should not be asked to approve a tag nobody wants any more.
 */
export const withdrawProposal = (mediaId, proposalId) =>
  inTransaction(async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM tag_proposal_media pm
       USING tag_proposals p
       WHERE pm.proposal_id = p.id AND p.status = 'pending'
         AND pm.proposal_id = $1 AND pm.media_id = $2`,
      [proposalId, mediaId]
    );
    if (rowCount === 0) throw notFound("ההצעה לא נמצאה, או שכבר הוכרעה");
    await client.query(
      `DELETE FROM tag_proposals p
       WHERE p.id = $1 AND p.status = 'pending'
         AND NOT EXISTS (SELECT 1 FROM tag_proposal_media pm WHERE pm.proposal_id = p.id)`,
      [proposalId]
    );
  });

/**
 * The admin's queue: every pending proposal, who asked, and which items wait on
 * it. The parent travels as an id; the client has the tree and draws the path
 * from it, the same way the picker does.
 */
export const getPendingProposals = async () => {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.parent_id, p.created_at,
            u.display_name AS proposed_by_name,
            COALESCE(
              json_agg(json_build_object('id', m.id, 'title', m.title) ORDER BY m.id)
                FILTER (WHERE m.id IS NOT NULL),
              '[]'
            ) AS media
     FROM tag_proposals p
     LEFT JOIN users u ON u.id = p.proposed_by
     LEFT JOIN tag_proposal_media pm ON pm.proposal_id = p.id
     LEFT JOIN media_items m ON m.id = pm.media_id
     WHERE p.status = 'pending'
     GROUP BY p.id, u.display_name
     ORDER BY p.created_at, p.id`
  );
  return rows;
};

// Locks the proposal for the decision. FOR UPDATE so two admins deciding at once
// cannot both approve it, or one approve and the other reject.
const lockPending = async (client, id) => {
  const { rows } = await client.query(
    "SELECT id, name, parent_id, status FROM tag_proposals WHERE id=$1 FOR UPDATE",
    [id]
  );
  if (rows.length === 0) throw notFound("ההצעה לא נמצאה");
  if (rows[0].status !== "pending") throw conflict("This proposal has already been decided", ERROR_CODES.TAG_PROPOSAL_DECIDED);
  return rows[0];
};

/**
 * Approves a proposal: the tag enters the tree and every item that asked for it
 * is tagged with it, in one transaction.
 *
 * The admin may correct the name and the place first — the lecturer's spelling
 * or branch is a suggestion, and fixing it here beats approving it wrong and
 * renaming afterwards. What is stored on the proposal is what was approved.
 *
 * @param {number|string} id
 * @param {number} adminId
 * @param {{ name?: unknown, parentId?: unknown }} [changes] omit parentId to
 *   keep the proposed place; null makes it a root.
 */
export const approveTagProposal = (id, adminId, changes = {}) =>
  inTransaction(async (client) => {
    const proposal = await lockPending(client, id);
    const name = changes.name === undefined ? proposal.name : requireTagName(changes.name);
    const parentId =
      "parentId" in changes ? await resolveParentId(client, changes.parentId) : proposal.parent_id;

    const tagId = await ensureTag(client, parentId, name);
    const { rows: waiting } = await client.query(
      "SELECT media_id FROM tag_proposal_media WHERE proposal_id=$1",
      [id]
    );
    const mediaIds = waiting.map((r) => r.media_id);
    await attachTag(client, tagId, mediaIds);

    await client.query(
      `UPDATE tag_proposals
       SET status='approved', name=$2, parent_id=$3, tag_id=$4, decided_by=$5, decided_at=NOW()
       WHERE id=$1`,
      [id, name, parentId, tagId, adminId]
    );
    return { id: Number(id), tag_id: tagId, name, parent_id: parentId, tagged_count: mediaIds.length };
  });

/** Refuses a proposal. The items keep every tag they had; only the request goes. */
export const rejectTagProposal = (id, adminId, reason) =>
  inTransaction(async (client) => {
    await lockPending(client, id);
    const cleanReason = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 500) : null;
    await client.query(
      `UPDATE tag_proposals
       SET status='rejected', rejection_reason=$2, decided_by=$3, decided_at=NOW()
       WHERE id=$1`,
      [id, cleanReason, adminId]
    );
    return { id: Number(id), status: "rejected" };
  });
