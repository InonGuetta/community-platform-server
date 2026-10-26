-- What a mailed token is FOR.
--
-- 017 created password_resets for reset links, and email verification later
-- reused the same table (servicesAuth.issueVerificationToken) on the reasoning
-- that both are "a single-use, expiring, hashed credential mailed to an address".
-- What that missed is that the two lookups read the table by token_hash ALONE, so
-- each accepted the other's token:
--
--   * a verification link — valid for 24 hours — was also a working password
--     reset link, three times longer than the one hour the reset flow promises;
--   * a reset link could mark an address verified.
--
-- The column makes the purpose part of the lookup. Every INSERT in the service
-- now names it, and both reads filter on it.
--
-- Rows that exist when this runs get 'legacy', which NEITHER flow accepts. They
-- cannot be told apart after the fact, and failing closed costs at most one
-- re-request for a link issued in the last 24 hours before deploy — far cheaper
-- than leaving every outstanding verification link usable as a reset for a day.
--
-- ADD COLUMN IF NOT EXISTS carries the CHECK with it, so a re-run skips both.
ALTER TABLE password_resets
  ADD COLUMN IF NOT EXISTS purpose VARCHAR(16) NOT NULL DEFAULT 'legacy'
    CHECK (purpose IN ('legacy', 'reset', 'verify'));
