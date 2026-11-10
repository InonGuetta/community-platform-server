// @ts-check
// Tags the LLM proposes for a lesson (PRD ARCH-4, migration 044).
//
// After the summary is written, the model is shown the whole tag tree — every
// tag as a path, "תנ\"ך > תורה > בראשית" — with the lesson's title, summary and
// key points, and picks three to five. Those are stored as PROPOSALS
// (media_ai_tag_suggestions); a person turns them into tags or dismisses them.
// Nothing here ever writes media_tags on its own.
//
// From the summary rather than the transcript: the summary already says what
// the lesson is about in a few hundred words, and the transcript would cost a
// hundred times as much to say the same thing to the same question.
//
// gpt-4o. gpt-4o-mini was tried first, on a real lesson, and was not good
// enough: it filed a lesson on settling the Land of Israel under "מעגל השנה"
// and one on Temple customs under "הלכות שבת". The tree is ~300 paths, so this
// is a cent or two a lesson — small beside the summary, which already reads the
// whole transcript with the same model.
//
// Lib/tagSuggestions.js still offers its guess from the title right after an
// upload, before any of this exists. The two are different signals and are not
// merged: that one knows the title, this one has read the lesson.
import { pool } from "../../db/pool.js";
import { withTransaction } from "../../db/transaction.js";
import { meterOpenAI } from "../../lib/openaiClient.js";
import { logger } from "../../lib/logger.js";
import { badRequest, ERROR_CODES } from "../../lib/AppError.js";
import { openai as baseOpenai, interactiveOpenai as baseInteractiveOpenai } from "./gpt.js";
import { getTagTree, setMediaTags } from "../servicesTags.js";

export const TAGGING_MODEL = "gpt-4o";
export const MIN_SUGGESTIONS = 3;
export const MAX_SUGGESTIONS = 5;

// Metered like every client (PRD ADM-1). The worker's, with its patient retry
// budget, after processing; the interactive one when a lecturer presses the
// button and waits.
const workerOpenai = meterOpenAI(baseOpenai, "tagging");
const interactiveOpenai = meterOpenAI(baseInteractiveOpenai, "tagging");

// Which tags the model is offered: all but a top-level category that has tags
// under it. Those are too broad to narrow anything — "מוסר וחסידות" on a
// lesson tells a filter almost nothing — and in the first measurements they
// were where most of the wrong choices landed.
export const candidateTags = (tags) => {
  const parents = new Set(tags.map((t) => (t.parent_id == null ? null : Number(t.parent_id))).filter((p) => p !== null));
  return tags.filter((t) => !(t.parent_id == null && parents.has(Number(t.id))));
};

// Every tag as its path from the root, so two tags with one name ("שמות" the
// book and "שמות" the parasha) are two different lines to the model.
export const tagPaths = (tags) => {
  const byId = new Map(tags.map((t) => [Number(t.id), t]));
  const pathOf = (tag) => {
    const names = [];
    const seen = new Set();
    for (let t = tag; t && !seen.has(t.id); t = byId.get(Number(t.parent_id))) {
      seen.add(t.id);
      names.unshift(t.name);
    }
    return names.join(" > ");
  };
  return tags.map((t) => ({ id: Number(t.id), path: pathOf(t) }));
};

export const buildTaggingPrompt = ({ title, summary, keyPoints = [] }, paths) => [
  {
    role: "system",
    content:
      "You file Torah lessons in a Hebrew archive by choosing tags from a fixed list. " +
      `Choose up to ${MAX_SUGGESTIONS} tags that clearly describe what the lesson is about — usually ${MIN_SUGGESTIONS} to ${MAX_SUGGESTIONS}, ` +
      "but fewer is better than a tag that only loosely fits; never pad the list. " +
      "Choose the most specific tag that fits: never a broad category when a tag under it fits, and never both a tag and one of its ancestors. " +
      "Do not choose a tag only because a word appears in passing. " +
      "Use only ids from the list. For each, give one short sentence in Hebrew saying why. " +
      'Reply with JSON only: {"tags":[{"id":<number>,"reason":"<Hebrew sentence>"}]}',
  },
  {
    role: "user",
    content: [
      "Tags (id: path):",
      ...paths.map((p) => `${p.id}: ${p.path}`),
      "",
      `Lesson title: ${title || ""}`,
      `Summary: ${summary || ""}`,
      ...(keyPoints.length ? ["Key points:", ...keyPoints.map((k) => `- ${typeof k === "string" ? k : k?.text ?? ""}`)] : []),
    ].join("\n"),
  },
];

/**
 * The model's answer, checked: only ids that exist, none the lesson already
 * carries, each once, at most MAX_SUGGESTIONS — and nothing at all for an
 * answer that is not the JSON asked for. A reason is trimmed and capped; a
 * missing one is allowed.
 *
 * And nothing that says less than what is already there: a tag ABOVE one the
 * lesson carries ("דברים" on a lesson tagged "כי תבא") or above another chosen
 * tag adds no reach — the archive's filter on a branch already finds everything
 * under it. Measured on a real lesson, the first answer offered exactly that.
 * `tags` is the tree, for the ancestry; without it only the plain checks run.
 */
export const parseTagChoices = (raw, validIds, alreadyTagged = [], tags = []) => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const valid = new Set([...validIds].map(Number));
  const taken = new Set(alreadyTagged.map(Number));
  const seen = new Set();
  const out = [];
  for (const choice of Array.isArray(parsed?.tags) ? parsed.tags : []) {
    const id = Number(choice?.id);
    if (!valid.has(id) || taken.has(id) || seen.has(id)) continue;
    seen.add(id);
    const reason = typeof choice?.reason === "string" ? choice.reason.trim().slice(0, 300) : "";
    out.push({ id, reason: reason || null });
  }

  const parentOf = new Map(tags.map((t) => [Number(t.id), t.parent_id == null ? null : Number(t.parent_id)]));
  const ancestorsOf = (id) => {
    const above = new Set();
    for (let p = parentOf.get(id); p != null && !above.has(p); p = parentOf.get(p)) above.add(p);
    return above;
  };
  const covered = new Set();
  for (const id of [...taken, ...out.map((c) => c.id)]) for (const a of ancestorsOf(id)) covered.add(a);
  return out.filter((c) => !covered.has(c.id)).slice(0, MAX_SUGGESTIONS);
};

// The proposals still open for a lesson — those not already among its tags —
// each with its path, so the screen can tell two same-named tags apart.
export const getAiTagSuggestions = async (mediaId) => {
  const { rows } = await pool.query(
    `WITH RECURSIVE chain AS (
       SELECT s.tag_id AS sid, t.id, t.name, t.parent_id, 0 AS depth
         FROM media_ai_tag_suggestions s JOIN tags t ON t.id = s.tag_id
        WHERE s.media_id = $1
       UNION ALL
       SELECT c.sid, p.id, p.name, p.parent_id, c.depth + 1
         FROM chain c JOIN tags p ON p.id = c.parent_id
        WHERE c.depth < 20
     )
     SELECT s.tag_id AS id, t.name, s.reason,
            (SELECT string_agg(c.name, ' > ' ORDER BY c.depth DESC) FROM chain c WHERE c.sid = s.tag_id) AS path
       FROM media_ai_tag_suggestions s JOIN tags t ON t.id = s.tag_id
      WHERE s.media_id = $1
        AND NOT EXISTS (SELECT 1 FROM media_tags mt WHERE mt.media_id = s.media_id AND mt.tag_id = s.tag_id)
      ORDER BY s.created_at, t.name`,
    [mediaId]
  );
  return rows;
};

/**
 * Asks the model and replaces the lesson's open proposals with its answer.
 * `interactive` — a person is waiting (the button), so fail fast.
 *
 * Throws only for a lesson with nothing to read yet; the caller after
 * processing treats any failure as non-fatal.
 */
export const suggestTagsForMedia = async (mediaId, { interactive = false } = {}) => {
  const { rows: [lesson] } = await pool.query(
    `SELECT m.title, t.ai_summary, t.ai_key_points
       FROM media_items m LEFT JOIN transcripts t ON t.media_id = m.id
      WHERE m.id = $1`,
    [mediaId]
  );
  if (!lesson?.ai_summary) {
    throw badRequest("This lesson has no summary to choose tags from yet", ERROR_CODES.NO_TRANSCRIPT_CONTENT);
  }

  const tags = await getTagTree();
  if (tags.length === 0) return [];
  const { rows: current } = await pool.query("SELECT tag_id FROM media_tags WHERE media_id = $1", [mediaId]);
  const all = tagPaths(tags);
  const offered = new Set(candidateTags(tags).map((t) => Number(t.id)));
  const paths = all.filter((p) => offered.has(p.id));

  const client = interactive ? interactiveOpenai : workerOpenai;
  const completion = await client.chat.completions.create({
    model: TAGGING_MODEL,
    temperature: 0.2,
    max_tokens: 500,
    response_format: { type: "json_object" },
    messages: buildTaggingPrompt(
      {
        title: lesson.title,
        summary: lesson.ai_summary,
        keyPoints: Array.isArray(lesson.ai_key_points) ? lesson.ai_key_points : [],
      },
      paths
    ),
  });
  const choices = parseTagChoices(
    completion.choices?.[0]?.message?.content ?? "",
    paths.map((p) => p.id),
    current.map((r) => r.tag_id),
    tags
  );

  await withTransaction(async (db) => {
    await db.query("DELETE FROM media_ai_tag_suggestions WHERE media_id = $1", [mediaId]);
    if (choices.length > 0) {
      await db.query(
        `INSERT INTO media_ai_tag_suggestions (media_id, tag_id, reason)
         SELECT $1, c.id, c.reason FROM unnest($2::int[], $3::text[]) AS c(id, reason)`,
        [mediaId, choices.map((c) => c.id), choices.map((c) => c.reason)]
      );
    }
  });
  logger.debug(`[tagging] mediaId=${mediaId} proposed ${choices.length} tag(s)`);
  return getAiTagSuggestions(mediaId);
};

/**
 * Accepts some of the open proposals: adds them to the lesson's tags (through
 * setMediaTags, so the per-lesson limit still holds) and closes them. Only
 * proposals actually open for this lesson can be accepted — an id from
 * elsewhere is refused rather than quietly tagged.
 */
export const approveAiTags = async (mediaId, tagIds) => {
  const open = new Set((await getAiTagSuggestions(mediaId)).map((s) => Number(s.id)));
  if (!tagIds.every((id) => open.has(id))) throw badRequest("Only open suggestions can be approved");
  const { rows: current } = await pool.query("SELECT tag_id FROM media_tags WHERE media_id = $1", [mediaId]);
  await setMediaTags(mediaId, { ids: [...current.map((r) => Number(r.tag_id)), ...tagIds] });
  await dismissAiTags(mediaId, tagIds);
  return getAiTagSuggestions(mediaId);
};

// Closes proposals without tagging — some, or (with no list) all of them.
export const dismissAiTags = async (mediaId, tagIds = null) => {
  await pool.query(
    `DELETE FROM media_ai_tag_suggestions
      WHERE media_id = $1 AND ($2::int[] IS NULL OR tag_id = ANY($2::int[]))`,
    [mediaId, tagIds]
  );
  return getAiTagSuggestions(mediaId);
};
