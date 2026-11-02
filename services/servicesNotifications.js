// @ts-check
// Notifications — the one way anything in the platform tells a person that
// something happened (PRD 6.15). Migrations 035 and 036 explain the tables.
//
// ── One function writes them ────────────────────────────────────────────────
//
// deliver() stores the in-app rows and decides, per recipient, whether the same
// event is also mailed. notify(), notifyAdmins() and every helper below go
// through it, so a new kind of notification is a new TYPE plus a call — not a
// new table, a new mail path and a new badge.
//
// ── Best-effort, always ─────────────────────────────────────────────────────
//
// Every caller is in the middle of something that has already succeeded: a role
// request is saved, a transcript is written, a session is created. A
// notification that cannot be stored or sent must not turn that into a failure —
// a 500 on "request a role" would invite a second request, and a throw in the
// worker after status='done' would make Bull retry a finished job and pay OpenAI
// for it again. So nothing exported here throws; it logs, without anybody's
// address, and reports what it managed.
import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { sendNotificationEmail } from "../lib/mailer.js";
import { signUnsubscribeToken } from "../lib/unsubscribe.js";
import { getSessionSchedule } from "./servicesSessions.js";

export const NOTIFICATION_TYPES = Object.freeze({
  // To every admin: somebody asked to be a lecturer or an admin (REG-11).
  ROLE_REQUEST: "role_request",
  // To the lesson's uploader: the pipeline finished, or gave up (NOTIF-1).
  PROCESSING_DONE: "processing_done",
  PROCESSING_ERROR: "processing_error",
  // To the host's students (NOTIF-2, LIVE-6): a session was scheduled, is
  // about to begin, or has begun.
  SESSION_SCHEDULED: "session_scheduled",
  SESSION_REMINDER: "session_reminder",
  SESSION_STARTING: "session_starting",
  // To a course's students: a lesson in it was published (NOTIF-8).
  NEW_LESSON: "new_lesson",
});

// What a person decides about (NOTIF-6) — the mail for a CATEGORY, not for each
// type: "lesson processing" rather than its success and its failure separately.
// The bell is not switchable; it is the record.
//
// `roles` is who the category can ever reach, so the preferences screen offers
// a student no switch for mail they will never be sent.
export const EMAIL_CATEGORIES = Object.freeze({
  sessions: { types: ["session_scheduled", "session_reminder", "session_starting"], roles: ["student", "lecturer", "admin"] },
  new_lessons: { types: ["new_lesson"], roles: ["student", "lecturer", "admin"] },
  processing: { types: ["processing_done", "processing_error"], roles: ["lecturer", "admin"] },
  role_requests: { types: ["role_request"], roles: ["admin"] },
});

// "Stop all of it", from the unsubscribe page. One row, so it also covers any
// category added after it was written.
export const ALL_CATEGORIES = "all";

export const categoryOf = (type) =>
  Object.entries(EMAIL_CATEGORIES).find(([, c]) => c.types.includes(type))?.[0] ?? null;

export const isEmailCategory = (category) => category === ALL_CATEGORIES || category in EMAIL_CATEGORIES;

// How many the bell shows. The table keeps everything; the menu is "what is
// new", and thirty is more than anybody scrolls in a dropdown.
export const LIST_LIMIT = 30;

/**
 * Tell a set of users that something happened — the one writer.
 *
 * One INSERT for the whole audience, however large: a session announced to a
 * lecturer's two hundred students is one statement, not two hundred.
 *
 * In that statement, per recipient:
 *   · an inactive account is skipped — it cannot sign in to read the bell, and
 *     mail to somebody an admin switched off is mail they did not agree to;
 *   · with `onceBy`, somebody who already has this type for the same payload
 *     value is skipped. A lesson unpublished and republished is one lesson, and
 *     its students hear about it once;
 *   · whether to mail is read from their opt-outs (migration 036) — the row
 *     comes back with `mail` already decided.
 *
 * @param {number[]} userIds
 * @param {string} type     one of NOTIFICATION_TYPES
 * @param {Record<string, unknown>} [payload] facts the client and the mailer word — ids, a title, a name
 * @param {{ onceBy?: string, attachments?: object[] }} [options]
 * @returns {Promise<number>} how many in-app rows were written
 */
export const deliver = async (userIds, type, payload = {}, { onceBy, attachments } = {}) => {
  const ids = [...new Set((userIds ?? []).map(Number).filter(Number.isInteger))];
  if (ids.length === 0) return 0;
  const category = categoryOf(type);
  const onceValue = onceBy ? String(payload[onceBy] ?? "") : null;
  try {
    // Every parameter that appears twice carries an explicit cast. Postgres
    // deduces a parameter's type from each place it is used, and $2 is both a
    // value inserted into a VARCHAR column and an operand compared with one —
    // without the casts it refuses the statement ("inconsistent types deduced
    // for parameter $2"). The stubbed tests cannot see that; smoke can.
    const { rows } = await pool.query(
      `INSERT INTO notifications (user_id, type, payload)
       SELECT u.id, $2::text, $3::jsonb FROM users u
       WHERE u.id = ANY($1::int[]) AND u.is_active = TRUE
         AND ($5::text IS NULL OR NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.user_id = u.id AND n.type = $2::text AND n.payload->>$5 = $6::text
         ))
       RETURNING user_id,
         (SELECT email FROM users WHERE id = user_id) AS email,
         NOT EXISTS (
           SELECT 1 FROM notification_email_optouts o
           WHERE o.user_id = notifications.user_id AND o.category IN ($4::text, '${ALL_CATEGORIES}')
         ) AS mail`,
      [ids, type, JSON.stringify(payload), category, onceBy ?? null, onceValue]
    );

    // One at a time rather than all at once: an SMTP relay rate-limits a burst,
    // and sendMail never throws, so a failure costs one message, not the rest.
    // The rows are already written — the mail is the best effort on top.
    for (const row of rows) {
      if (!row.mail || !row.email || !category) continue;
      await sendNotificationEmail(row.email, type, payload, {
        unsubscribeToken: signUnsubscribeToken(row.user_id, category),
        attachments,
      });
    }
    return rows.length;
  } catch (err) {
    logger.warn(`[notify] ${type} for ${ids.length} user(s) failed: ${err.message}`);
    return 0;
  }
};

/**
 * Tell one user. Returns whether the in-app row was written.
 *
 * @param {number} userId
 * @param {string} type
 * @param {Record<string, unknown>} [payload]
 */
export const notify = async (userId, type, payload = {}) => (await deliver([userId], type, payload)) > 0;

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
    return deliver(rows.map((row) => row.id), type, payload);
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

// ── Live sessions (NOTIF-2, NOTIF-3, LIVE-6) ────────────────────────────────
//
// WHO hears about a session. A session has no course and no invite list —
// anyone signed in may join any session — so "its participants" is not
// something the data records. Every user would be a mass mailing on each
// session somebody creates. The audience is therefore the host's students:
// everybody enrolled in a course the host teaches, the same people the host's
// "התלמידים שלי" lists (servicesCourses.getStudentsOfLecturer). An admin or a
// lecturer who teaches no course announces to nobody, which is honest: there
// is nobody the platform knows to be theirs.
const sessionAudience = async (hostId) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT e.student_id AS id
     FROM courses c JOIN enrollments e ON e.course_id = c.id
     WHERE c.lecturer_id = $1 AND e.student_id <> $1`,
    [hostId]
  );
  return rows.map((row) => row.id);
};

const sessionPayload = (session) => ({
  sessionId: Number(session.id),
  title: session.title,
  hostName: session.host_name,
  ...(session.starts_at ? { startsAt: new Date(session.starts_at).toISOString() } : {}),
});

/**
 * Tell the host's students about a session: scheduled, about to start, or
 * started. A scheduled one's mail carries the calendar file.
 *
 * @param {number} sessionId
 * @param {string} type  SESSION_SCHEDULED | SESSION_REMINDER | SESSION_STARTING
 * @param {{ calendar?: (session: any) => string }} [options]  builds the .ics, for SCHEDULED
 */
export const notifySessionAudience = async (sessionId, type, { calendar } = {}) => {
  try {
    const session = await getSessionSchedule(sessionId);
    if (!session?.host_id) return 0;
    const audience = await sessionAudience(session.host_id);
    if (audience.length === 0) return 0;
    const attachments = calendar && session.starts_at
      ? [{ filename: "session.ics", content: calendar(session), contentType: "text/calendar; charset=utf-8; method=PUBLISH" }]
      : undefined;
    return deliver(audience, type, sessionPayload(session), { attachments });
  } catch (err) {
    logger.warn(`[notify] ${type} for session ${sessionId} failed: ${err.message}`);
    return 0;
  }
};

// How far ahead the reminder goes out, and how late it may still go out. The
// window's lower edge is what stops a server that was down for a day from
// reminding everybody about yesterday's sessions when it comes back.
export const REMINDER_LEAD_MINUTES = 15;
const REMINDER_GRACE_MINUTES = 5;

/**
 * LIVE-6. Claim every session about to begin and remind its audience. Run by
 * the API server's timer (lib/sessionReminders.js) once a minute.
 *
 * The UPDATE both finds the sessions and marks them, in one statement: a
 * session is reminded by whichever process claims it first, exactly once.
 *
 * @returns {Promise<number>} how many sessions were reminded
 */
export const sendDueSessionReminders = async () => {
  try {
    const { rows } = await pool.query(
      `UPDATE live_sessions SET reminder_sent_at = NOW()
       WHERE is_active = TRUE AND started_at IS NULL AND reminder_sent_at IS NULL
         AND scheduled_at IS NOT NULL
         AND (scheduled_at AT TIME ZONE 'UTC') <= NOW() + INTERVAL '${REMINDER_LEAD_MINUTES} minutes'
         AND (scheduled_at AT TIME ZONE 'UTC') > NOW() - INTERVAL '${REMINDER_GRACE_MINUTES} minutes'
       RETURNING id`
    );
    for (const row of rows) await notifySessionAudience(row.id, NOTIFICATION_TYPES.SESSION_REMINDER);
    return rows.length;
  } catch (err) {
    logger.warn(`[notify] session reminders failed: ${err.message}`);
    return 0;
  }
};

// ── A new lesson in a course (NOTIF-8) ──────────────────────────────────────
//
// When a lesson in a course becomes visible to its students — published while
// in the course, or moved into the course while published. The decision of
// WHEN is the controller's (it holds the row before and after the edit); this
// only checks the row as it now stands and tells the course.
//
// Once per student per lesson (onceBy mediaId): a lesson unpublished to fix a
// typo and republished is not news twice. The uploader is not told about their
// own lesson.

/** @param {number} mediaId */
export const notifyNewLesson = async (mediaId) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.title, m.media_type, m.creator_name, m.uploader_id, m.course_id, m.is_published,
              c.title AS course_title
       FROM media_items m JOIN courses c ON c.id = m.course_id
       WHERE m.id = $1`,
      [mediaId]
    );
    const media = rows[0];
    if (!media?.is_published || !media.course_id) return 0;
    const students = await pool.query(
      "SELECT student_id FROM enrollments WHERE course_id = $1 AND student_id <> $2",
      [media.course_id, media.uploader_id ?? 0]
    );
    return deliver(
      students.rows.map((row) => row.student_id),
      NOTIFICATION_TYPES.NEW_LESSON,
      {
        mediaId: Number(media.id),
        title: media.title,
        mediaType: media.media_type,
        creatorName: media.creator_name,
        courseId: Number(media.course_id),
        courseTitle: media.course_title,
      },
      { onceBy: "mediaId" }
    );
  } catch (err) {
    logger.warn(`[notify] new lesson ${mediaId} failed: ${err.message}`);
    return 0;
  }
};

// ── Preferences (NOTIF-6) ───────────────────────────────────────────────────

/** The categories this user has turned the mail off for. */
export const getEmailOptOuts = async (userId) => {
  const { rows } = await pool.query(
    "SELECT category FROM notification_email_optouts WHERE user_id = $1 ORDER BY category",
    [userId]
  );
  return rows.map((row) => row.category);
};

/**
 * Turn one category's mail on or off. Idempotent both ways.
 *
 * @param {number} userId
 * @param {string} category  a key of EMAIL_CATEGORIES, or ALL_CATEGORIES
 * @param {boolean} wantsEmail
 */
export const setEmailPreference = async (userId, category, wantsEmail) => {
  if (wantsEmail) {
    await pool.query(
      "DELETE FROM notification_email_optouts WHERE user_id = $1 AND category = $2",
      [userId, category]
    );
  } else {
    await pool.query(
      `INSERT INTO notification_email_optouts (user_id, category) VALUES ($1, $2)
       ON CONFLICT (user_id, category) DO NOTHING`,
      [userId, category]
    );
  }
};
