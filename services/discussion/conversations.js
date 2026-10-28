// @ts-check
// ── The conversation store (migration 032) ──────────────────────────────────
//
// Reads and writes for ai_conversations / ai_messages. Two rules hold across
// every function here, and the tests assert both:
//
// 1. A conversation is reached through (user_id, media_id) of the CALLER, never
//    by its id alone. An id from a request could be anyone's, and a lookup that
//    trusted it would hand one student another's questions. The history view
//    does take an id from the request — the conversation the reader picked —
//    but only ever looks it up together with the caller and the lesson
//    (ownedConversation), so another reader's id is simply not found. The
//    functions that take a bare id (appendMessage, getRecentMessages) are for
//    the chat service, which obtains that id for the caller first.
//
//    A deleted conversation (migration 034) is not there: every read below
//    filters `deleted_at IS NULL`. The one exception is countQuestionsToday —
//    deleting a conversation must not refund the questions asked in it.
//
// 2. The lesson's visibility is asked BEFORE anything is read or written. A
//    student who has left a course keeps their rows, but cannot open them
//    through a lesson they may no longer see — the same 404 the lesson itself
//    now answers.
import { pool } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { notFound, ERROR_CODES } from "../../lib/AppError.js";
import { assertCanSeeLesson } from "./access.js";

// How many messages the tab loads. A conversation longer than this shows its
// most recent part — still in order, oldest of them first.
export const MESSAGES_PAGE = 100;

const CONVERSATION_COLS = "id, media_id, created_at, updated_at";
const MESSAGE_COLS = "id, role, content, citations, created_at";

// Migration 034. In every read of ai_conversations, and in none of the quota.
const LIVE = "deleted_at IS NULL";

const latestFor = async (userId, mediaId) => {
  const { rows } = await pool.query(
    `SELECT ${CONVERSATION_COLS} FROM ai_conversations
     WHERE user_id = $1 AND media_id = $2 AND ${LIVE}
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
    [userId, mediaId]
  );
  return rows[0] ?? null;
};

// The newest MESSAGES_PAGE messages, returned oldest-first — the order a chat
// is read in. The inner query takes the newest; the outer one turns them round.
const messagesOf = async (conversationId, limit = MESSAGES_PAGE) => {
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT ${MESSAGE_COLS} FROM ai_messages
       WHERE conversation_id = $1
       ORDER BY id DESC
       LIMIT $2
     ) newest
     ORDER BY id`,
    [conversationId, limit]
  );
  return rows;
};

/**
 * The caller's most recently active conversation on this lesson, with its
 * messages. `conversation` is null when they have never asked anything here —
 * an empty tab, not an error.
 * @param {number} userId
 * @param {number|string} mediaId
 * @param {{ courses: number[]|null, drafts: number[]|null }} scope
 */
export const getLatestConversation = async (userId, mediaId, scope) => {
  await assertCanSeeLesson(mediaId, scope);
  const conversation = await latestFor(userId, mediaId);
  if (!conversation) return { conversation: null, messages: [] };
  const messages = await messagesOf(conversation.id);
  logger.debug(`[BE:svc] getLatestConversation mediaId=${mediaId} conversation=${conversation.id} messages=${messages.length}`);
  return { conversation, messages };
};

/**
 * "שיחה חדשה". If the latest conversation has no messages yet, it IS a new
 * conversation, and is returned rather than a second empty one created beside
 * it — so a double-click, or pressing the button twice, leaves one row.
 * @param {number} userId
 * @param {number|string} mediaId
 * @param {{ courses: number[]|null, drafts: number[]|null }} scope
 */
export const startConversation = async (userId, mediaId, scope) => {
  await assertCanSeeLesson(mediaId, scope);

  const latest = await latestFor(userId, mediaId);
  if (latest) {
    const { rows } = await pool.query(
      "SELECT 1 FROM ai_messages WHERE conversation_id = $1 LIMIT 1",
      [latest.id]
    );
    if (rows.length === 0) return { conversation: latest, messages: [], created: false };
  }

  const { rows } = await pool.query(
    `INSERT INTO ai_conversations (user_id, media_id)
     VALUES ($1, $2)
     RETURNING ${CONVERSATION_COLS}`,
    [userId, mediaId]
  );
  logger.debug(`[BE:svc] startConversation mediaId=${mediaId} ✓ conversation=${rows[0].id}`);
  return { conversation: rows[0], messages: [], created: true };
};

/**
 * The conversation a question is asked in: the caller's latest on this lesson,
 * or a new one when they have none. Unlike startConversation this never opens a
 * second conversation beside one that has messages — asking a question
 * continues the conversation on screen.
 *
 * Does NOT check visibility: its one caller, the chat, has already done so, and
 * asking twice is a second query per question for nothing.
 * @param {number} userId
 * @param {number|string} mediaId
 */
export const getOrStartConversation = async (userId, mediaId) => {
  const latest = await latestFor(userId, mediaId);
  if (latest) return latest;
  const { rows } = await pool.query(
    `INSERT INTO ai_conversations (user_id, media_id)
     VALUES ($1, $2)
     RETURNING ${CONVERSATION_COLS}`,
    [userId, mediaId]
  );
  return rows[0];
};

/**
 * Append one message and move the conversation's updated_at forward — in ONE
 * statement, so the two can never disagree about whether the message exists.
 * For the chat service, which has already resolved the conversation for the
 * caller; see rule 1 at the top of this file.
 * @param {number} conversationId
 * @param {{ role: "user"|"assistant", content: string, citations?: object[] }} message
 */
export const appendMessage = async (conversationId, { role, content, citations = [] }) => {
  const { rows } = await pool.query(
    `WITH msg AS (
       INSERT INTO ai_messages (conversation_id, role, content, citations)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING ${MESSAGE_COLS}
     ), touched AS (
       UPDATE ai_conversations SET updated_at = NOW() WHERE id = $1
     )
     SELECT * FROM msg`,
    [conversationId, role, content, JSON.stringify(citations)]
  );
  return rows[0];
};

// ── History: the caller's earlier conversations on this lesson ──────────────

// How many conversations the history lists. A reader with more on one lesson
// sees the most recent; nothing is lost, the rest are older.
export const HISTORY_PAGE = 50;

// How much of the first question titles a conversation in the list.
const TITLE_CHARS = 140;

/**
 * The caller's conversations on this lesson that have anything in them,
 * most recently active first. Each is titled by its first question.
 * @param {number} userId
 * @param {number|string} mediaId
 * @param {{ courses: number[]|null, drafts: number[]|null }} scope
 */
export const listConversations = async (userId, mediaId, scope) => {
  await assertCanSeeLesson(mediaId, scope);
  const { rows } = await pool.query(
    `SELECT c.id, c.created_at, c.updated_at,
       COUNT(m.id) FILTER (WHERE m.role = 'user')::int AS questions,
       (SELECT LEFT(q.content, ${TITLE_CHARS}) FROM ai_messages q
        WHERE q.conversation_id = c.id AND q.role = 'user'
        ORDER BY q.id LIMIT 1) AS first_question
     FROM ai_conversations c
     JOIN ai_messages m ON m.conversation_id = c.id
     WHERE c.user_id = $1 AND c.media_id = $2 AND c.${LIVE}
     GROUP BY c.id
     ORDER BY c.updated_at DESC, c.id DESC
     LIMIT ${HISTORY_PAGE}`,
    [userId, mediaId]
  );
  return rows;
};

// One conversation, only if it is the caller's and on this lesson — the one
// place an id from the request is accepted (rule 1). Anyone else's is 404, the
// same answer as an id that does not exist, so ids cannot be probed.
const ownedConversation = async (userId, mediaId, conversationId) => {
  const { rows } = await pool.query(
    `SELECT ${CONVERSATION_COLS} FROM ai_conversations
     WHERE id = $1 AND user_id = $2 AND media_id = $3 AND ${LIVE}`,
    [conversationId, userId, mediaId]
  );
  if (rows.length === 0) throw notFound("Conversation not found", ERROR_CODES.NOT_FOUND);
  return rows[0];
};

/**
 * One earlier conversation, to read in the history.
 * @param {number} userId
 * @param {number|string} mediaId
 * @param {number|string} conversationId
 * @param {{ courses: number[]|null, drafts: number[]|null }} scope
 */
export const getConversationById = async (userId, mediaId, conversationId, scope) => {
  await assertCanSeeLesson(mediaId, scope);
  const conversation = await ownedConversation(userId, mediaId, conversationId);
  return { conversation, messages: await messagesOf(conversation.id) };
};

/**
 * "המשך את השיחה הזו": make an earlier conversation the current one again.
 *
 * The chat always asks in the caller's most recently active conversation
 * (getOrStartConversation), so resuming is nothing more than moving this one's
 * updated_at forward — no second notion of "current" to keep in step. The
 * UPDATE itself carries the ownership test.
 * @param {number} userId
 * @param {number|string} mediaId
 * @param {number|string} conversationId
 * @param {{ courses: number[]|null, drafts: number[]|null }} scope
 */
export const resumeConversation = async (userId, mediaId, conversationId, scope) => {
  await assertCanSeeLesson(mediaId, scope);
  const { rows } = await pool.query(
    `UPDATE ai_conversations SET updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND media_id = $3 AND ${LIVE}
     RETURNING ${CONVERSATION_COLS}`,
    [conversationId, userId, mediaId]
  );
  if (rows.length === 0) throw notFound("Conversation not found", ERROR_CODES.NOT_FOUND);
  logger.debug(`[BE:svc] resumeConversation mediaId=${mediaId} ✓ conversation=${rows[0].id}`);
  return { conversation: rows[0], messages: await messagesOf(rows[0].id) };
};

/**
 * Delete one of the caller's conversations on this lesson, from the history.
 *
 * The rows stay and the words go (migration 034): the conversation is marked
 * deleted and every message in it emptied, in ONE statement, so there is no
 * moment at which it is hidden but still holds the text, or emptied but still
 * listed. The rows are kept because the daily quota counts them.
 *
 * The ownership test is in the WHERE, as in resumeConversation: another
 * reader's id, or one already deleted, matches nothing and is a 404.
 *
 * Deleting the current conversation needs nothing more: the chat asks in the
 * latest live one (latestFor), which is now the one before it, or none.
 * @param {number} userId
 * @param {number|string} mediaId
 * @param {number|string} conversationId
 * @param {{ courses: number[]|null, drafts: number[]|null }} scope
 */
export const deleteConversation = async (userId, mediaId, conversationId, scope) => {
  await assertCanSeeLesson(mediaId, scope);
  const { rows } = await pool.query(
    `WITH gone AS (
       UPDATE ai_conversations SET deleted_at = NOW()
       WHERE id = $1 AND user_id = $2 AND media_id = $3 AND ${LIVE}
       RETURNING id
     ), emptied AS (
       UPDATE ai_messages SET content = '', citations = '[]'::jsonb
       WHERE conversation_id IN (SELECT id FROM gone)
     )
     SELECT id FROM gone`,
    [conversationId, userId, mediaId]
  );
  if (rows.length === 0) throw notFound("Conversation not found", ERROR_CODES.NOT_FOUND);
  logger.debug(`[BE:svc] deleteConversation mediaId=${mediaId} ✓ conversation=${rows[0].id}`);
  return { deleted: true, id: rows[0].id };
};

/**
 * How many questions this user has had answered today, across every lesson —
 * what the daily quota is counted against (PRD ASK-5).
 *
 * Counted from ai_messages rather than a counter of its own: a question is
 * stored only together with its answer (chat.js, property 4), so a failed
 * answer — which the reader is told to retry — never uses up the quota.
 * Deleted conversations are counted too, on purpose (migration 034): the
 * quota is what was answered, not what is still kept.
 *
 * "Today" is the day in Jerusalem, so the quota resets at midnight where the
 * readers are, not at midnight UTC. created_at is a timestamp WITHOUT time
 * zone written by NOW(), i.e. wall-clock time in the database session's zone;
 * Jerusalem's midnight is converted into that same zone before comparing.
 * @param {number} userId
 */
export const countQuestionsToday = async (userId) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM ai_messages m
     JOIN ai_conversations c ON c.id = m.conversation_id
     WHERE c.user_id = $1
       AND m.role = 'user'
       AND m.created_at >= (
         date_trunc('day', NOW() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem'
       ) AT TIME ZONE current_setting('TimeZone')`,
    [userId]
  );
  return rows[0]?.n ?? 0;
};

/**
 * The last `limit` messages, oldest first — the history the chat sends the
 * model with each question.
 * @param {number} conversationId
 * @param {number} limit
 */
export const getRecentMessages = (conversationId, limit) => messagesOf(conversationId, limit);
