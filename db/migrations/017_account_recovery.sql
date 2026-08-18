-- Password reset, email verification, and the one thing that makes a reset mean
-- something: invalidating the sessions that existed before it.
--
-- Everything here is IF NOT EXISTS / IF EXISTS because db/migrate.js re-runs
-- every file on every invocation and only skips a statement when Postgres
-- answers "already exists".

-- ── Reset tokens ────────────────────────────────────────────────────────────
--
-- The token itself is NEVER stored. What is kept is a SHA-256 of it, and the
-- reason is the threat this feature actually has: a reset table full of live
-- tokens is a list of one-click takeovers for every account with a request
-- outstanding, so a leaked backup or a stray SELECT would be worse than the
-- password hashes next door. A hash is enough to look one up, because the token
-- is 32 random bytes and does not need stretching the way a chosen password
-- does — there is nothing to guess.
--
-- CHAR(64) because a hex SHA-256 is exactly that, always.
CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  -- Stamped rather than deleted, so a token used twice is distinguishable from
  -- one that never existed — the second attempt is worth seeing in the log.
  used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- The lookup every confirm does: by hash, which is already UNIQUE above.
-- This one is for the sweep that clears expired rows, and for invalidating every
-- outstanding token for a user once one of them is spent.
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS idx_password_resets_expires ON password_resets(expires_at);

-- ── Users ───────────────────────────────────────────────────────────────────

-- Whether the address on the account has been proven to belong to whoever is
-- using it. Existing rows default to FALSE, which is honest: nobody has ever
-- proven any of them.
--
-- It is deliberately NOT a gate on signing in. Locking out every account that
-- predates this column would be a migration that takes the platform down, and
-- the value here is elsewhere — see servicesAuth.googleOAuthLogin, where an
-- unverified local password is exactly what must not be allowed to survive a
-- Google identity claiming the same address.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- When the password last changed, and the reason a reset actually ends a
-- compromise rather than merely getting in the way of one.
--
-- The JWT is stateless and lasts seven days, so before this an attacker holding
-- a stolen cookie kept full access for a week AFTER the owner changed their
-- password — which is the moment the feature is supposed to be for. Every token
-- carries an `iat`, so middleware/auth.js compares it against this column and
-- refuses anything minted earlier. No blacklist, no extra query: verifyToken
-- already reads this row on every request.
--
-- NULL means "never changed since this column existed", which no token can be
-- older than, so existing sessions survive the migration.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP;
