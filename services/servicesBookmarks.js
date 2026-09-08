// @ts-check
import { pool } from "../db/pool.js";
import { getChunkForAnchor, getChunkContaining } from "./transcripts/chunks.js";
import { logger } from "../lib/logger.js";
import { notFound, badRequest, ERROR_CODES } from "../lib/AppError.js";

// Imported from transcripts/chunks.js directly rather than through the
// servicesTranscripts barrel. The barrel re-exports pipeline.js, which opens the
// Bull queues at import time — so reaching for it here would make creating a
// bookmark depend on Redis being importable. chunks.js pulls only the pool.

// Joined to media so the notebook can show which lecture each bookmark came
// from without a request per bookmark. Ordering by title first groups a
// cross-lecture list by lecture; for the media-scoped call every row shares one
// title, so it collapses to the timestamp ordering NotesPanel relies on.
export const getBookmarksByUser = async (userId, mediaId) => {
  let query = `
    SELECT b.*, m.title AS media_title, m.media_type
    FROM bookmarks b
    LEFT JOIN media_items m ON m.id = b.media_id
    WHERE b.user_id=$1`;
  const params = [userId];
  if (mediaId) {
    params.push(mediaId);
    query += ` AND b.media_id=$${params.length}`;
  }
  // Two coordinate spaces in one list, so both appear in the ORDER BY and each
  // is NULL for the other kind. A recording orders by second, a book by offset;
  // the NULLS FIRST/LAST choice is irrelevant WITHIN one media item because only
  // one of the two is ever populated there.
  //
  // This is already the reading order for a book: ASC puts the NULL timestamps
  // last as a group, every row of a book ties there, and char_position breaks
  // the tie. The client re-sorts the same list by timestamp alone, which is a
  // separate bug and is fixed on that side.
  //
  // page_number joins the ordering for the third kind. A bookmark placed on a
  // page of the original has neither a second nor an offset, so without it every
  // one of them ties and a sefer's marks come back in whatever order the planner
  // felt like — the same failure the client's comparator had.
  query += " ORDER BY m.title NULLS LAST, b.timestamp_seconds ASC, b.char_position ASC, b.page_number ASC";
  const result = await pool.query(query, params);
  return result.rows;
};

// Returned by both writes below, so a created bookmark and an edited one have
// the same shape. A bare RETURNING * gives back only the bookmarks columns, and
// the client appends that row straight into the list it already holds; in the
// notebook, which groups every bookmark under its lecture, a row missing the
// title landed in a group headed "שיעור" in the neutral grey instead of under
// the lecture it belongs to, and stayed wrong until the next reload.
const WITH_MEDIA = `
  SELECT b.*, m.title AS media_title, m.media_type
  FROM changed b
  LEFT JOIN media_items m ON m.id = b.media_id`;

/**
 * Resolve where in a book a passage sits, and refuse it if it sits nowhere.
 *
 * Returns the chunk row, so the caller can copy its page number onto the
 * bookmark. Never returns a chunk the range does not fit inside — a bookmark
 * whose end is past the paragraph it claims to be in cannot be drawn back onto
 * the page, and storing it would make that failure appear later, silently, as a
 * highlight in the wrong place.
 *
 * The two ways in exist for two different callers. The reader knows exactly
 * which chunk it drew the marker on and says so; anything older sends only an
 * offset, and the containing chunk is looked up for it. Both end at the same
 * validation, which is the point of resolving before writing rather than after.
 */
const resolveAnchor = async ({ mediaId, chunkId, charPosition, charEnd }) => {
  const chunk = chunkId
    ? await getChunkForAnchor(mediaId, chunkId)
    : await getChunkContaining(mediaId, charPosition);

  if (!chunk) {
    // The honest reading of this is almost always "the book was re-extracted
    // since this page was loaded" — the chunk ids and the offsets on screen
    // describe a text that no longer exists. It is a 400 the user can act on
    // (reload and mark again), which is why it earns a code of its own rather
    // than the generic BAD_REQUEST.
    throw badRequest(
      "This passage no longer exists in the book — it may have been re-processed",
      ERROR_CODES.BOOKMARK_ANCHOR_INVALID
    );
  }

  const outside =
    charPosition < chunk.char_start ||
    charPosition > chunk.char_end ||
    (charEnd !== null && charEnd > chunk.char_end);

  if (outside) {
    throw badRequest(
      "The marked passage does not fit inside the paragraph it points at",
      ERROR_CODES.BOOKMARK_ANCHOR_INVALID
    );
  }

  return chunk;
};

/**
 * A bookmark anchors EITHER to a moment (audio, video) or to a passage in the
 * text (a book).
 *
 * Named arguments rather than positional, and that is not a style preference.
 * The list had grown to a timestamp, an offset and now an end, a chunk and a
 * quote — five numbers and strings in a row, of which two are offsets into a
 * book and one is a number of seconds. One transposed call site would store a
 * position as a timestamp and nothing anywhere would notice.
 */
export const createBookmark = async ({
  userId,
  mediaId,
  timestampSeconds = null,
  note = null,
  charPosition = null,
  charEnd = null,
  chunkId = null,
  quotedText = null,
  pageNumber = null,
  rect = null,
}) => {
  // Exactly the guarantee migration 027's CHECK constraint enforces, stated here
  // so the caller gets a 400 that names the problem instead of a driver error
  // quoting a constraint name.
  //
  // Three kinds now: a moment in a recording, a passage in the extracted text,
  // or a rectangle on a page of the original. The third is what the "מקור" tab
  // produces, and it is the only one that does not depend on the extraction —
  // so it is also the only one re-running the pipeline cannot orphan.
  const hasPageAnchor = rect !== null;
  if (timestampSeconds === null && charPosition === null && !hasPageAnchor) {
    throw badRequest("A bookmark needs a timestamp, a position in the text, or a place on a page");
  }
  // A rectangle without a page is a place on no page at all.
  if (hasPageAnchor && !Number.isInteger(pageNumber)) {
    throw badRequest("A place on a page needs the page it is on");
  }
  // And the guarantee 026's CHECK cannot make: the constraint only enforces
  // ordering, because legacy point anchors and re-extracted bookmarks must stay
  // storable. Completeness of a range is a rule about NEW writes, so it lives
  // here — the same division of labour, stated in both files.
  if (charEnd !== null && charPosition === null) {
    throw badRequest("A passage cannot have an end without a start");
  }
  if (charEnd !== null && charEnd < charPosition) {
    throw badRequest("A passage cannot end before it starts");
  }
  // A range of zero length is not a passage. It would be stored happily — the
  // CHECK permits char_end = char_position — listed in the side panel, and
  // rendered as nothing at all, because segmentChunk drops a mark it cannot
  // paint. That is the same shape of failure migration 022 added its constraint
  // to prevent: a row that is visible in the list and points at nothing the
  // reader can see.
  //
  // The thing the caller meant is a point anchor, which is spelled by leaving
  // charEnd out — so the message says that rather than only refusing.
  if (charEnd !== null && charEnd === charPosition) {
    throw badRequest(
      "A passage of zero length is not a passage — omit charEnd to mark the paragraph instead",
      ERROR_CODES.BOOKMARK_ANCHOR_INVALID
    );
  }

  // Resolved before the INSERT, so a bookmark is never written pointing at a
  // paragraph that is not there. Only for a book: a recording has no chunk
  // offsets to check against and never had.
  const chunk = charPosition === null
    ? null
    : await resolveAnchor({ mediaId, chunkId, charPosition, charEnd });

  logger.debug(
    `[BE:svc] createBookmark userId=${userId} mediaId=${mediaId} ` +
    `chunkId=${chunk?.id ?? "-"} range=${charPosition ?? "-"}..${charEnd ?? "-"} ` +
    `page=${chunk?.page_number ?? pageNumber ?? "-"} rect=${rect ? "yes" : "-"} ` +
    `quoted=${quotedText === null ? 0 : quotedText.length}ch`
  );

  const result = await pool.query(
    `WITH changed AS (
       INSERT INTO bookmarks
         (user_id, media_id, timestamp_seconds, note, char_position, char_end, chunk_id, quoted_text,
          page_number, rect_x, rect_y, rect_w, rect_h)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *
     )
     ${WITH_MEDIA}`,
    [
      userId,
      mediaId,
      timestampSeconds,
      note,
      charPosition,
      charEnd,
      // The resolved chunk, not the one the client claimed: for a caller that
      // sent only an offset this is the whole point, and for one that sent an id
      // it is the same id, already proved to belong to this media item.
      chunk?.id ?? null,
      quotedText,
      // For a text bookmark this is copied at write time rather than read
      // through the join later — see migration 026: after a re-extraction the
      // chunk is gone and the page is the only way left to find the passage by
      // hand. For a page anchor it comes from the viewer and IS half the anchor.
      chunk?.page_number ?? pageNumber,
      rect?.x ?? null,
      rect?.y ?? null,
      rect?.w ?? null,
      rect?.h ?? null,
    ]
  );
  return result.rows[0];
};

export const updateBookmark = async (id, userId, note) => {
  const result = await pool.query(
    `WITH changed AS (
       UPDATE bookmarks SET note=$1 WHERE id=$2 AND user_id=$3
       RETURNING *
     )
     ${WITH_MEDIA}`,
    [note, id, userId]
  );
  if (result.rows.length === 0) throw notFound("Bookmark not found", ERROR_CODES.BOOKMARK_NOT_FOUND);
  return result.rows[0];
};

export const deleteBookmark = async (id, userId) => {
  const result = await pool.query(
    "DELETE FROM bookmarks WHERE id=$1 AND user_id=$2 RETURNING id",
    [id, userId]
  );
  if (result.rows.length === 0) throw notFound("Bookmark not found", ERROR_CODES.BOOKMARK_NOT_FOUND);
  return { deleted: true, id };
};
