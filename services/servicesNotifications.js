// @ts-check
// Notifications — the one way anything in the platform tells a person that
// something happened (PRD 6.15). Migration 035 explains the table.
//
// ── One function writes them ────────────────────────────────────────────────
//
// notify() stores the in-app row and decides whether the same event is also
// mailed. Every caller goes through it, so a new kind of notification is a new
// TYPE plus a call — not a new table, a new mail path and a new badge. That is
// the whole point of building this before the second and third kinds arrive
// (prompt 5: sessions, new lessons, preferences).
//
// ── Best-effort, always ─────────────────────────────────────────────────────
//
// Every caller is in the middle of something that has already succeeded: a role
// request is saved, a transcript is written. A notification that cannot be
// stored or sent must not turn that into a failure — a 500 on "request a role"
// would invite a second request, and a throw in the worker after status='done'
// would make Bull retry a finished job and pay OpenAI for it again. So notify
// never throws; it logs, without the recipient's address, and reports false.
import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { sendNotificationEmail } from "../lib/mailer.js";

export const NOTIFICATION_TYPES = Object.freeze({
  // To every admin: somebody asked to be a lecturer or an admin (REG-11).
  ROLE_REQUEST: "role_request",
  // To the lesson's uploader: the pipeline finished, or gave up (NOTIF-1).
  PROCESSING_DONE: "processing_done",
  PROCESSING_ERROR: "processing_error",
});

// Whether a type is mailed as well as shown in the bell.
//
// A default per type, in code, until people can choose (NOTIF-6, prompt 5) — at
// which point the per-user preference is consulted here and this table becomes
// what a user who never chose gets. All three are mailed: each is something the
// recipient is waiting on and would otherwise learn only by coming back to look.
const EMAIL_BY_DEFAULT = {
  [NOTIFICATION_TYPES.ROLE_REQUEST]: true,
  [NOTIFICATION_TYPES.PROCESSING_DONE]: true,
  [NOTIFICATION_TYPES.PROCESSING_ERROR]: true,
};

const wantsEmail = (type) => EMAIL_BY_DEFAULT[type] === true;

// How many the bell shows. The table keeps everything; the menu is "what is
// new", and thirty is more than anybody scrolls in a dropdown.
export const LIST_LIMIT = 30;

/**
 * Tell one user that something happened.
 *
 * @param {number} userId
 * @param {string} type     one of NOTIFICATION_TYPES
 * @param {Record<string, unknown>} [payload] facts the client and the mailer word — ids, a title, a name
 * @returns {Promise<boolean>} whether the in-app row was written
 */
export const notify = async (userId, type, payload = {}) => {
  try {
    // A deactivated account is not told anything: it cannot sign in to read
    // the bell, and mail to somebody an admin switched off is mail they did not
    // agree to keep receiving.
    const { rows } = await pool.query(
      `INSERT INTO notifications (user_id, type, payload)
       SELECT u.id, $2, $3::jsonb FROM users u
       WHERE u.id = $1 AND u.is_active = TRUE
       RETURNING id, (SELECT email FROM users WHERE id = $1) AS email`,
      [userId, type, JSON.stringify(payload)]
    );
    if (rows.length === 0) return false;

    if (wantsEmail(type) && rows[0].email) {
      // The row is what notify promises; the mail is sendMail's best effort.
      // It never throws — a failure is logged there — so it cannot undo the row.
      await sendNotificationEmail(rows[0].email, type, payload);
    }
    return true;
  } catch (err) {
    logger.warn(`[notify] ${type} for user ${userId} failed: ${err.message}`);
    return false;
  }
};

/**
 * Tell every active admin. Returns how many were told.
 *
 * @param {string} type
 * @param {Record<string, unknown>} [payload]
 */
export const notifyAdmins = async (type, payload = {}) => {
  try {
    const { rows } = await pool.query(
      "SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE"
    );
    const sent = await Promise.all(rows.map((row) => notify(row.id, type, payload)));
    return sent.filter(Boolean).length;
  } catch (err) {
    logger.warn(`[notify] ${type} for admins failed: ${err.message}`);
    return 0;
  }
};

// ── Reading and marking ─────────────────────────────────────────────────────
//
// Every statement below carries `user_id = $1`. A notification id comes from the
// request, and an id that is not the caller's is answered exactly like one that
// does not exist — the same rule as the AI conversation history.

export const listForUser = async (userId) => {
  const [items, unread] = await Promise.all([
    pool.query(
      `SELECT id, type, payload, read_at, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT ${LIST_LIMIT}`,
      [userId]
    ),
    pool.query(
      "SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL",
      [userId]
    ),
  ]);
  return { items: items.rows, unread: unread.rows[0]?.count ?? 0 };
};

// Returns whether the row exists and is the caller's. Marking a row already read
// is not an error — two tabs, one click each.
export const markRead = async (userId, id) => {
  const { rowCount } = await pool.query(
    `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
     WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rowCount > 0;
};

export const markAllRead = async (userId) => {
  await pool.query(
    "UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL",
    [userId]
  );
};

// The counter on the admin's "משתמשים" tab (REG-11). The same condition the
// users page lists by (servicesUsers.getPendingApprovals), so the number on the
// tab is the number of rows waiting behind it.
export const countPendingRoleRequests = async () => {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM users WHERE approval_status = 'pending'"
  );
  return rows[0]?.count ?? 0;
};

// ── The pipeline's outcome (NOTIF-1) ────────────────────────────────────────
//
// Called by the workers at the two points where a lesson's processing ENDS:
// status='done' written with the summary (llmWorker), or status='error' written
// on the final attempt (either worker). Never between retries — a failure Bull
// will retry is not an outcome, and telling somebody "it failed" a minute before
// it succeeds is the polling bug llmWorker's catch already describes.
//
// To the uploader: they pressed the button and are the one waiting. Read here,
// not passed in, because neither worker has the row — the job carries only the
// id, deliberately (see CLAUDE.md, "Only the id travels in a job body").
//
// `reason` only for a failure the user can act on — the extraction stage's
// AppError ("לא נמצא טקסט קריא בקובץ."). A transient failure's message is an
// OpenAI or driver string and is not theirs to read.

/**
 * @param {number} mediaId
 * @param {{ ok: boolean, reason?: string | null }} outcome
 */
export const notifyProcessingOutcome = async (mediaId, { ok, reason = null }) => {
  try {
    const { rows } = await pool.query(
      "SELECT uploader_id, title, media_type FROM media_items WHERE id = $1",
      [mediaId]
    );
    const media = rows[0];
    if (!media?.uploader_id) return false;
    return notify(
      media.uploader_id,
      ok ? NOTIFICATION_TYPES.PROCESSING_DONE : NOTIFICATION_TYPES.PROCESSING_ERROR,
      {
        mediaId: Number(mediaId),
        title: media.title,
        mediaType: media.media_type,
        ...(!ok && reason ? { reason } : {}),
      }
    );
  } catch (err) {
    logger.warn(`[notify] processing outcome for media ${mediaId} failed: ${err.message}`);
    return false;
  }
};
