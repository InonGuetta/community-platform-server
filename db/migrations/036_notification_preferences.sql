-- Notification preferences, unsubscribing, and session reminders
-- (PRD NOTIF-6, LIVE-6). Builds on 035_create_notifications.sql.
--
-- ── Opt-OUTS, not a preferences row ─────────────────────────────────────────
--
-- What a user can turn off is the MAIL for a category of notification; the bell
-- always shows everything (it is the record, and it costs nobody anything). So
-- the table records only the exceptions: a row means "do not mail me this", and
-- its absence means the default — which is to mail. Nobody needs a row written
-- for them on signup, a category added later reaches everybody at once, and
-- "unsubscribe from everything" is one row with category 'all' rather than one
-- per category that would miss the next one added.
--
-- `category` rather than notification type: a person decides about "lesson
-- processing", not separately about its success and its failure. The mapping
-- from type to category lives in services/servicesNotifications.js.
--
-- CASCADE with the user, for the reason the notifications themselves have it.
-- The primary key is the index on the foreign key (user_id leads it).
--
-- ── live_sessions.reminder_sent_at ──────────────────────────────────────────
--
-- LIVE-6: a reminder shortly before a scheduled session. A timer in the API
-- server looks for sessions about to begin, and claims each one by setting this
-- column in the same UPDATE that finds it — `WHERE reminder_sent_at IS NULL ...
-- RETURNING`. Two server processes running the timer at once therefore cannot
-- both send a session's reminders, and a restart cannot send them twice.
--
-- TIMESTAMPTZ, like 035 and unlike the rest of live_sessions: see 035 for what
-- a zoneless column does to a time read back in Node.
--
-- Idempotent, like every migration here: db/migrate.js re-runs every file.

CREATE TABLE IF NOT EXISTS notification_email_optouts (
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    VARCHAR(40) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, category)
);

ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
