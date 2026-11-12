-- Notifications: one table for every "something happened that you should know"
-- (PRD 6.15, NOTIF-1/4/7, REG-11).
--
-- Until this the platform's only outbound channel was mail, and only for four
-- fixed messages. A lecturer uploaded a lesson and had no way to learn that its
-- processing had finished or failed short of opening it again; an admin learned
-- of a role request only by happening to open the users page. The PRD's
-- instruction was one mechanism rather than four point solutions, so every
-- notification is a row here, written by ONE function — services/
-- servicesNotifications.js → notify() — which also decides whether it is mailed.
--
-- ── type + payload, not a rendered message ──────────────────────────────────
--
-- The row stores WHAT happened (`type`) and the facts needed to describe it
-- (`payload`: an id, a title, a name), never Hebrew prose. The client words it,
-- and the mailer words it, each for its own medium. A sentence stored here would
-- be frozen at the day it was written: a renamed lesson, a reworded string or a
-- second language could never reach the rows already sent.
--
-- `type` is VARCHAR rather than an enum: adding one (prompt 5 adds several) is
-- then a code change, not a migration, and an unknown type in an old row is
-- rendered generically by the client rather than failing a cast.
--
-- ── ON DELETE CASCADE ───────────────────────────────────────────────────────
--
-- A notification belongs to its recipient and means nothing without them;
-- deleting a user takes their inbox. The objects a payload NAMES (a lesson, the
-- user who asked for a role) are deliberately not foreign keys: a lesson deleted
-- after "processing finished" leaves that fact true, and the client simply
-- finds nothing at the link.
--
-- ── TIMESTAMPTZ, unlike most of the schema ──────────────────────────────────
--
-- The bell says "לפני 5 דקות", so these times are read to the minute. A plain
-- TIMESTAMP holds the database's UTC wall-clock with no zone, and node-postgres
-- parses a zoneless value as the SERVER PROCESS's local time — in Israel that
-- turned "a minute ago" into "לפני 2 שעות". A zoned column arrives as an exact
-- instant whatever the process's zone.
--
-- ── Indexes ─────────────────────────────────────────────────────────────────
--
-- The bell asks two questions, on every poll, for every signed-in user:
-- "my latest N" and "how many unread". The first is (user_id, created_at DESC);
-- the second is a partial index over unread rows only, which stays small however
-- long the history grows. Together they also cover the foreign key.
--
-- Idempotent, like every migration here: db/migrate.js re-runs every file.

CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(40) NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id)
  WHERE read_at IS NULL;
