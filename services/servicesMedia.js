// @ts-check
import { pool } from "../db/pool.js";
import { visibleMediaSql } from "../lib/permissions.js";
import { notFound, badRequest, ERROR_CODES } from "../lib/AppError.js";

// ── Attribution ─────────────────────────────────────────────────────────────
//
// What a media item stores when nobody said who taught or wrote it. Every row
// has a value: the column is NOT NULL and 020_creator_name.sql defaults to this,
// so "unattributed" is a real answer rather than a null every caller has to
// think about.
export const DEFAULT_CREATOR = "כללי";

// Matches VARCHAR(120) in 020_creator_name.sql. SQL cannot import this, so the
// migration carries a comment naming this constant — the pair has to change
// together, and a column narrower than the check turns a clear 400 into a driver
// error. Same arrangement as playlists.title and TITLE_MAX in servicesSaves.
const CREATOR_NAME_MAX = 120;

// Normalising lives HERE, not in the controller, so the rule holds for anything
// that writes a media row — a direct API call, a future import script, the
// recording feature. A blank field and an absent one mean the same thing and
// must not produce different rows.
//
// Whitespace-only is treated as blank on purpose: a name of " " would otherwise
// become a distinct "creator" that sorts to the top of every filter list and is
// impossible to type again.
const cleanCreatorName = (value) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return DEFAULT_CREATOR;
  if (trimmed.length > CREATOR_NAME_MAX) {
    throw badRequest(`Creator name must be at most ${CREATOR_NAME_MAX} characters`);
  }
  return trimmed;
};

// The course and the teaching lecturer travel with every media row so the
// archive can label a card without a second request per item. `lecturer_name`
// falls back to the uploader: most existing items have no lecturer_id, and
// showing nothing there reads as missing data rather than "not recorded yet".
// `has_transcript` rides along so an archive card can decide whether to offer
// "download transcript" without a request per card. EXISTS rather than a join:
// the answer is a boolean and joining transcript_chunks would multiply the media
// rows. It asks for actual content — a transcripts row can exist while still
// pending or failed, and offering a download that produces an empty file is
// worse than not offering it.
const MEDIA_COLUMNS = `
  m.*,
  u.display_name AS uploader_name,
  c.title AS course_title,
  COALESCE(l.display_name, u.display_name) AS lecturer_name,
  (
    EXISTS (SELECT 1 FROM transcript_chunks tc WHERE tc.media_id = m.id)
    OR EXISTS (
      SELECT 1 FROM transcripts t
      WHERE t.media_id = m.id AND COALESCE(t.edited_text, '') <> ''
    )
  ) AS has_transcript,
  -- How many people liked this. Until now a like was recorded and then only ever
  -- read back to the person who left it, so the button lit up for them and told
  -- nobody else anything: a lecturer had no way to know a lecture had landed, and
  -- an archive of hundreds gave no signal about which of them anyone valued.
  -- Aliased lk, not l — l is already the lecturer join above, and a subquery
  -- reusing it would silently resolve against the outer scope.
  (SELECT COUNT(*)::int FROM likes lk WHERE lk.media_id = m.id) AS like_count,
  -- The item's tags, as an array of names. A correlated subquery rather than a
  -- join: joining media_tags would multiply the media rows by their tag count
  -- and every aggregate above would then have to be re-thought. COALESCE so an
  -- untagged item arrives as [] and no caller has to branch on null.
  COALESCE(
    (SELECT ARRAY_AGG(t.name ORDER BY t.name)
     FROM media_tags mt JOIN tags t ON t.id = mt.tag_id
     WHERE mt.media_id = m.id),
    ARRAY[]::varchar[]
  ) AS tags,
  -- The same tags as IDS, and both are needed for different jobs. A card shows
  -- names; a form that edits them cannot work from names at all, because five
  -- names in this taxonomy occur in two branches — "שופטים" the parasha and
  -- "שופטים" the book — so re-saving a matched-by-name tag would file the item
  -- under whichever of the two happened to be found first.
  COALESCE(
    (SELECT ARRAY_AGG(mt.tag_id ORDER BY mt.tag_id)
     FROM media_tags mt
     WHERE mt.media_id = m.id),
    ARRAY[]::int[]
  ) AS tag_ids`;

const MEDIA_JOINS = `
  FROM media_items m
  LEFT JOIN users u ON m.uploader_id = u.id
  LEFT JOIN users l ON m.lecturer_id = l.id
  LEFT JOIN courses c ON m.course_id = c.id`;

// What the user typed is a phrase to find, not a pattern to match with.
//
// The value is a bound parameter, so this was never an injection — but ILIKE
// reads % and _ as wildcards wherever they appear, and they appear in real
// titles. A search for "100%" matched every title starting "100", and one for
// "פרק_ב" matched "פרקאב". Backslash is Postgres' default LIKE escape, and it
// has to escape itself first or a title containing one would consume the
// character after it.
const escapeLike = (value) => String(value).replace(/[\\%_]/g, (char) => `\\${char}`);

// The zone the platform's days are measured in. See the date filter below.
const DISPLAY_TIMEZONE = "Asia/Jerusalem";

// A stored UTC timestamp, as the calendar date a reader here would call it.
const localDateSql = (column) =>
  `(${column} AT TIME ZONE 'UTC' AT TIME ZONE '${DISPLAY_TIMEZONE}')::date`;

export const getAllMedia = async (filters = {}) => {
  // The visibility rule opens the WHERE clause rather than being one more
  // optional `if` below, and that is the point: it is not a filter the caller
  // may or may not supply, it is the condition under which any of these rows may
  // be returned at all. `WHERE 1=1` with the rule as an optional addition put it
  // one forgotten argument away from listing the whole library.
  // Annotated because the elements are of mixed type: without it the array
  // infers from its first element and every push below is an error.
  //
  // `=== undefined` and NOT `??`, and the difference is the whole rule. null is a
  // meaningful value here — it is how "unrestricted" is spelled — so `?? []`
  // silently rewrote every lecturer and admin into someone enrolled in nothing,
  // emptying the archive of every course lesson and every draft for exactly the
  // people who are supposed to see them. Only an ABSENT argument may fail closed.
  //
  // The same distinction updateMedia draws with `"courseId" in body`, and
  // optionalSeconds with zero: presence is not the same question as value.
  /** @type {Array<string|number|boolean|number[]|null>} */
  const params = [
    filters.visibleCourses === undefined ? [] : filters.visibleCourses,
    // The second dimension, and it fails closed the same way: an absent argument
    // means nobody's drafts, never everybody's.
    filters.visibleDrafts === undefined ? [] : filters.visibleDrafts,
  ];
  let query = `SELECT ${MEDIA_COLUMNS} ${MEDIA_JOINS} WHERE ${visibleMediaSql("$1", "m", "$2")}`;

  if (filters.type) {
    params.push(filters.type);
    query += ` AND m.media_type=$${params.length}`;
  }
  if (filters.courseId !== undefined) {
    params.push(filters.courseId);
    query += ` AND m.course_id=$${params.length}`;
  }
  if (filters.published !== undefined) {
    params.push(filters.published);
    query += ` AND m.is_published=$${params.length}`;
  }
  // The creator is a narrowing filter like the type, not part of the search: it
  // is chosen from a list of exact values, so an exact match is what it means.
  if (filters.creator) {
    params.push(filters.creator);
    query += ` AND m.creator_name = $${params.length}`;
  }
  // ── Search ────────────────────────────────────────────────────────────
  //
  // Over the title, the attribution AND the tags. It used to be the title alone,
  // which made typing a tag name into the search box return nothing while the
  // filter beside it found ten items — two controls answering the same question
  // differently, with nothing on screen to explain why.
  //
  // By NAME here, deliberately, and it is not the ambiguity the tag filter
  // avoids: a search is "find me anything that mentions this", so matching both
  // שופטים the parasha and שופטים the book is the right answer. The filter is
  // where the caller says which one they meant.
  if (filters.search) {
    params.push(`%${escapeLike(filters.search)}%`);
    const term = params.length;
    query += ` AND (
      m.title ILIKE $${term}
      OR m.creator_name ILIKE $${term}
      OR EXISTS (
        SELECT 1 FROM media_tags mt
        JOIN tags t ON t.id = mt.tag_id
        WHERE mt.media_id = m.id AND t.name ILIKE $${term}
      )
    )`;
  }
  // ── Tags ──────────────────────────────────────────────────────────────
  //
  // By ID, not by name. The taxonomy in migration 025 legitimately repeats five
  // names in different branches — שופטים is both a parasha and a book — so a
  // name filter would silently match both and there is no way for the caller to
  // say which one it meant.
  //
  // Choosing a tag also chooses everything BENEATH it: picking "תורה" finds a
  // shiur tagged "וירא", which is the whole point of a hierarchy.
  //
  // ── OR inside a heading, AND between headings ─────────────────────────
  //
  // Two chosen tags under the SAME top-level heading are alternatives; two under
  // different headings are conditions. "בהר or בחוקותי" and "something in תנ"ך
  // that is also about מוסר" are both ordinary requests, and this is the only
  // arrangement that lets both be asked.
  //
  // It used to be AND across every chosen tag, and that made the commonest
  // request in the archive impossible: choosing two parashot asked for a shiur
  // that is simultaneously on both, of which there are almost none. The user saw
  // an empty archive and concluded the filter was broken — which is exactly what
  // it was.
  //
  // So the unit of AND is the HEADING (the root of the branch a choice sits in),
  // not the choice. Each chosen id is walked UP to the root it belongs to and
  // DOWN into its own subtree; an item satisfies a heading if it carries
  // anything in any subtree chosen under it, and must satisfy every heading
  // named. With one heading chosen this is a plain OR; with one tag it is what
  // it always was.
  if (Array.isArray(filters.tagIds) && filters.tagIds.length > 0) {
    params.push(filters.tagIds);
    const idsParam = params.length;
    // The heading each chosen tag belongs to, and every tag underneath the
    // choice. Written once as a string because the count below has to be
    // measured against the same walk — a second, differently-written copy is how
    // "matched every heading" and "how many headings were named" come to
    // disagree.
    const facets = `
        WITH RECURSIVE up AS (
          SELECT id AS chosen_id, id AS node_id, parent_id FROM tags WHERE id = ANY($${idsParam}::int[])
          UNION ALL
          SELECT u.chosen_id, t.id, t.parent_id FROM tags t JOIN up u ON t.id = u.parent_id
        ),
        heading AS (SELECT chosen_id, node_id AS facet_id FROM up WHERE parent_id IS NULL),
        down AS (
          SELECT id AS chosen_id, id AS tag_id FROM tags WHERE id = ANY($${idsParam}::int[])
          UNION ALL
          SELECT d.chosen_id, t.id FROM tags t JOIN down d ON t.parent_id = d.tag_id
        )`;
    query += ` AND (
      SELECT COUNT(DISTINCT sub.facet_id)
      FROM media_tags mt
      JOIN (${facets}
        SELECT h.facet_id, d.tag_id FROM down d JOIN heading h ON h.chosen_id = d.chosen_id
      ) sub ON sub.tag_id = mt.tag_id
      WHERE mt.media_id = m.id
    ) = (${facets}
      SELECT COUNT(DISTINCT facet_id) FROM heading
    )`;
  }
  // ── Tags taken back out ───────────────────────────────────────────────
  //
  // "Everything in תורה except שמות" — a request the filter above cannot express
  // on its own, and the reason it cannot is worth stating so nobody tries the
  // shortcut again. Chosen tags combine with AND, so naming the four books to
  // keep asks for an item that is in בראשית and in שמות at once, and nothing is:
  // the archive comes back empty. Removal has to be its own list.
  //
  // An exclusion removes the whole SUBTREE, exactly as a choice adds one — the
  // hierarchy has to mean the same thing in both directions, or excluding שמות
  // would leave every parasha inside it still showing.
  //
  // NOT EXISTS rather than a count: one excluded tag on the item is enough, and
  // there is nothing to tally. It is also independent of the block above, which
  // is what lets "everything except X" be asked with no positive choice at all —
  // a legitimate request, and one that would otherwise have no way to be made.
  if (Array.isArray(filters.excludeTagIds) && filters.excludeTagIds.length > 0) {
    params.push(filters.excludeTagIds);
    query += ` AND NOT EXISTS (
      SELECT 1
      FROM media_tags mt
      JOIN (
        WITH RECURSIVE excluded_descendants AS (
          SELECT id AS tag_id FROM tags WHERE id = ANY($${params.length}::int[])
          UNION ALL
          SELECT t.id FROM tags t JOIN excluded_descendants e ON t.parent_id = e.tag_id
        )
        SELECT tag_id FROM excluded_descendants
      ) sub ON sub.tag_id = mt.tag_id
      WHERE mt.media_id = m.id
    )`;
  }
  // ── Upload date ───────────────────────────────────────────────────────
  //
  // Both ends optional and independent, so "everything since March" and
  // "everything before March" are both expressible.
  //
  // Compared as a LOCAL date, not as a UTC one, and that is a correctness fix
  // rather than a nicety. created_at is a TIMESTAMP stored in UTC; Israel is two
  // or three hours ahead. A shiur uploaded at 00:30 on the 6th is stored as
  // 21:30 or 22:30 on the FIFTH, so a plain comparison filed it under the wrong
  // day — and only ever for uploads near midnight, which makes the symptom look
  // random rather than systematic.
  //
  // The zone is named rather than taken from the request: this is a Hebrew,
  // Israel-facing platform, and a filter that quietly changed meaning with the
  // reader's laptop clock would be worse than one that is explicit. It is stated
  // in one constant so a second audience is a one-line change.
  if (filters.uploadedAfter) {
    params.push(filters.uploadedAfter);
    query += ` AND ${localDateSql("m.created_at")} >= $${params.length}::date`;
  }
  if (filters.uploadedBefore) {
    params.push(filters.uploadedBefore);
    // Inclusive of the chosen day. Comparing the local DATE rather than the
    // timestamp is what makes that true without the "+ 1 day" arithmetic the
    // previous version needed — and that arithmetic was in UTC too.
    query += ` AND ${localDateSql("m.created_at")} <= $${params.length}::date`;
  }

  query += " ORDER BY m.created_at DESC";
  const result = await pool.query(query, params);
  return result.rows;
};

// "Carry on where you left off" — the watch history, newest first.
//
// Built on MEDIA_COLUMNS and MEDIA_JOINS rather than its own column list, because
// what it returns is rendered by the same cards as the archive: a second list
// here would drift, and the symptom would be a shelf whose cards quietly lost
// their course label or their download button.
//
// The visibility rule applies to it like everything else, and here it earns its
// keep twice over: a lecture watched before the student was unenrolled — or
// before it was unpublished — drops off the shelf instead of sitting there as a
// card that 404s when clicked.
//
// A position of zero is excluded rather than shown: there is nothing to carry on
// from, and the row exists only because the player reported a position once.
export const getContinueWatching = async (userId, scope, limit = 12) => {
  const result = await pool.query(
    `SELECT ${MEDIA_COLUMNS},
            wp.last_position_seconds,
            wp.last_watched_at
     ${MEDIA_JOINS}
     JOIN watch_progress wp ON wp.media_id = m.id
     WHERE wp.user_id = $1
       AND wp.last_position_seconds > 0
       AND ${visibleMediaSql("$2", "m", "$3")}
     ORDER BY wp.last_watched_at DESC
     LIMIT $4`,
    [userId, scope.courses, scope.drafts, limit]
  );
  return result.rows;
};

export const getMediaById = async (id) => {
  const result = await pool.query(
    `SELECT ${MEDIA_COLUMNS} ${MEDIA_JOINS} WHERE m.id=$1`,
    [id]
  );
  if (result.rows.length === 0) throw notFound("Media not found", ERROR_CODES.MEDIA_NOT_FOUND);
  return result.rows[0];
};

export const createMedia = async (data) => {
  const { uploaderId, title, description, mediaType, s3Key, durationSeconds, thumbnailUrl, courseId, lecturerId, creatorName } = data;
  const result = await pool.query(
    `INSERT INTO media_items (uploader_id, title, description, media_type, s3_key, duration_seconds, thumbnail_url, course_id, lecturer_id, creator_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    // Passed explicitly rather than letting the column default fire: the default
    // only applies when the column is OMITTED from the INSERT, and this INSERT
    // names every column. cleanCreatorName is what turns an absent or blank
    // value into DEFAULT_CREATOR here.
    [uploaderId, title, description, mediaType, s3Key, durationSeconds, thumbnailUrl, courseId ?? null, lecturerId ?? null, cleanCreatorName(creatorName)]
  );
  return result.rows[0];
};

// course_id and lecturer_id use CASE rather than COALESCE, unlike every field
// above them. COALESCE cannot express "set this to NULL": it reads a null
// parameter as "leave it alone", which is right for a title and wrong for an
// association — removing a lesson from a course would be impossible. The
// accompanying booleans say whether the caller mentioned the field at all, which
// is the distinction COALESCE throws away.
export const updateMedia = async (id, data) => {
  const {
    title, description, isPublished, thumbnailUrl, durationSeconds,
    courseId, lecturerId, setCourse = false, setLecturer = false, creatorName,
  } = data;
  // COALESCE, like title above it, and NOT the CASE treatment the two
  // associations get. The distinction those need — "set this to NULL" versus
  // "leave it alone" — does not exist here: the column is NOT NULL, so there is
  // no null to set. Clearing the field means DEFAULT_CREATOR, which
  // cleanCreatorName already produces from an empty string, so an editor who
  // deletes the text gets "כללי" rather than an error.
  const nextCreator = creatorName === undefined ? null : cleanCreatorName(creatorName);
  const result = await pool.query(
    `UPDATE media_items SET
      title = COALESCE($1, title),
      description = COALESCE($2, description),
      is_published = COALESCE($3, is_published),
      thumbnail_url = COALESCE($4, thumbnail_url),
      duration_seconds = COALESCE($5, duration_seconds),
      course_id = CASE WHEN $6::boolean THEN $7::int ELSE course_id END,
      lecturer_id = CASE WHEN $8::boolean THEN $9::int ELSE lecturer_id END,
      creator_name = COALESCE($11, creator_name)
    WHERE id=$10 RETURNING *`,
    [title, description, isPublished, thumbnailUrl, durationSeconds,
      setCourse, courseId ?? null, setLecturer, lecturerId ?? null, id, nextCreator]
  );
  if (result.rows.length === 0) throw notFound("Media not found", ERROR_CODES.MEDIA_NOT_FOUND);
  return getMediaById(id);
};

export const deleteMedia = async (id) => {
  const result = await pool.query("DELETE FROM media_items WHERE id=$1 RETURNING id", [id]);
  if (result.rows.length === 0) throw notFound("Media not found", ERROR_CODES.MEDIA_NOT_FOUND);
  return { deleted: true, id };
};

export const saveWatchProgress = async (userId, mediaId, positionSeconds) => {
  const result = await pool.query(
    `INSERT INTO watch_progress (user_id, media_id, last_position_seconds, last_watched_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, media_id)
     DO UPDATE SET last_position_seconds=$3, last_watched_at=NOW()
     RETURNING *`,
    [userId, mediaId, positionSeconds]
  );
  return result.rows[0];
};

export const getWatchProgress = async (userId, mediaId) => {
  const result = await pool.query(
    "SELECT * FROM watch_progress WHERE user_id=$1 AND media_id=$2",
    [userId, mediaId]
  );
  return result.rows[0] || null;
};

/**
 * Every distinct creator in the library, with how many items each has.
 *
 * Its own query rather than being derived from the listing, and that is the
 * whole reason it exists: the archive now filters SERVER-side, so the rows it
 * holds are the filtered ones. Deriving the dropdown from them meant that
 * choosing "הרב כהן" left a dropdown containing only "הרב כהן" — no way back and
 * no way across without clearing the filter first.
 *
 * Scoped by the same visibility rule as the listing. A student must not learn
 * from a filter menu that a lecturer they cannot see exists.
 */
export const getCreators = async (scope) => {
  const { rows } = await pool.query(
    `SELECT m.creator_name AS name, COUNT(*)::int AS media_count
     ${MEDIA_JOINS}
     WHERE ${visibleMediaSql("$1", "m", "$2")}
     GROUP BY m.creator_name
     ORDER BY m.creator_name`,
    [scope.courses, scope.drafts]
  );
  return rows;
};

