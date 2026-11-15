-- Sign in with Apple and with LinkedIn, beside Google (008).
--
-- One column per provider, the same shape as google_id, rather than a separate
-- identities table: there are three providers, each is linked at most once per
-- account, and every rule about linking (servicesAuth.oauthLogin) is written
-- against "this account's id at this provider" — a column is exactly that.
--
-- UNIQUE because one identity at a provider is one account here; the constraint
-- carries its own index, which is the lookup every sign-in does. No foreign key
-- and so no ON DELETE to choose: the value is the provider's, not a row of ours.
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_id VARCHAR(255) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS linkedin_id VARCHAR(255) UNIQUE;
