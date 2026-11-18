-- A user's mobile number, and notifications by SMS beside the mail
-- (docs/phone-plan.md, PRD AUTH-13 / NOTIF-9).
--
-- ── users.phone_e164, users.phone_verified_at ──────────────────────────────
--
-- The number in E.164 ("+972501234567", lib/phone.js), and when the user proved
-- it is theirs by typing the code sent to it. Nothing is ever sent to a number
-- that is not verified — anybody can type somebody else's number into a form.
-- A verified number belongs to one account: the partial unique index. Verifying
-- a number another account holds moves it (services/servicesPhone.js), so the
-- form never tells a stranger whose number it is.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_e164 VARCHAR(16);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS users_verified_phone_unique
  ON users (phone_e164) WHERE phone_verified_at IS NOT NULL;

-- ── phone_verifications ─────────────────────────────────────────────────────
--
-- The code waiting to be typed: one per user (the primary key), replaced by a
-- new request. Only its SHA-256 is kept, as with password_resets (017): a table
-- of live codes would be a list of numbers anyone reading it could take over.
-- `attempts` caps the guessing at five; `expires_at` at ten minutes. The number
-- is not yet the user's — it moves onto the user row only once verified.
CREATE TABLE IF NOT EXISTS phone_verifications (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone_e164  VARCHAR(16) NOT NULL,
  code_hash   CHAR(64)    NOT NULL,
  attempts    INTEGER     NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── notification_sms_optins ─────────────────────────────────────────────────
--
-- The opposite of notification_email_optouts (036), deliberately: mail is on
-- unless turned off, SMS is OFF unless turned on — it costs money per message
-- and reaches a phone in a pocket. A row means "text me this category"; 'all'
-- is not a value here (turning everything off is deleting the rows).
CREATE TABLE IF NOT EXISTS notification_sms_optins (
  user_id   INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category  VARCHAR(32) NOT NULL,
  PRIMARY KEY (user_id, category)
);

-- ── sms_usage ───────────────────────────────────────────────────────────────
--
-- Every SMS sent (or that would have been, with no provider configured): what
-- for, how many segments, what it cost — for the admin's panel, the monthly cap
-- and the per-number rate limit on codes. The number itself is NOT stored, only
-- its SHA-256 (lib/phone.js → phoneHash): enough to count the codes sent to one
-- number in an hour, not enough to read anybody's number out of the table.
-- SET NULL with the user: the spend happened and stays counted.
CREATE TABLE IF NOT EXISTS sms_usage (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  purpose     VARCHAR(32)   NOT NULL,
  phone_hash  CHAR(64)      NOT NULL,
  segments    INTEGER       NOT NULL DEFAULT 1,
  cost_usd    NUMERIC(10,4) NOT NULL DEFAULT 0,
  status      VARCHAR(16)   NOT NULL,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sms_usage_user_idx ON sms_usage (user_id);
CREATE INDEX IF NOT EXISTS sms_usage_created_idx ON sms_usage (created_at);
CREATE INDEX IF NOT EXISTS sms_usage_phone_idx ON sms_usage (phone_hash, created_at);
