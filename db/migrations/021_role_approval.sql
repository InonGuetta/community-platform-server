-- Asking to be a lecturer, and an admin deciding.
--
-- ── The rule this schema exists to make unbreakable ─────────────────────────
--
-- Until now `register` accepted an email, a password and a display name, and
-- nothing else. That is WHY nobody could sign up as an admin: there was no way
-- to express the request. Adding a role picker to the form removes that
-- protection unless the request is stored somewhere that is not `users.role`.
--
-- So it is stored here, in requested_role, and `users.role` keeps its own rule:
-- every account is created 'student', without exception, and only an explicit
-- approval by a signed-in admin ever changes it. A client that POSTs
-- role=admin gets a student — see test/roleApproval.test.js, which exists for
-- precisely that one assertion.
--
-- ── Why not reuse is_active ─────────────────────────────────────────────────
--
-- Tempting: is_active=FALSE already blocks both login and every authenticated
-- request (servicesAuth and middleware/auth both check it), so "pending" would
-- have been free. It is the wrong column. is_active already means "switched off
-- by an admin" and the users table renders it as פעיל / לא פעיל — so using it
-- for "waiting" too would make a person awaiting approval and a person who was
-- suspended indistinguishable, in the UI and in every query. A rejected
-- applicant would look identical to a banned member.
--
-- ── DEFAULT 'approved' is what makes this migration harmless ────────────────
--
-- Every account that already exists keeps working, untouched, the moment this
-- runs. A default of 'pending' would have locked out the entire membership —
-- including the only admins who could unlock them.
--
-- CREATE TYPE has no IF NOT EXISTS in Postgres, and db/migrate.js re-runs every
-- file on every invocation. That is fine here: the runner treats 42710
-- (duplicate_object) as "already applied" and skips, which is the same
-- arrangement 001 and 006 rely on. Everything below it IS guarded, because
-- ALTER TABLE raises a different code the runner does not skip.
CREATE TYPE approval_status AS ENUM ('approved', 'pending', 'rejected');

-- What they asked to be. Deliberately nullable and deliberately NOT defaulted:
-- NULL means "never asked", which is what every existing row is and what a plain
-- student signup stays. Reusing the user_role enum rather than a text column so
-- an impossible value cannot be stored even if a caller gets past the service.
ALTER TABLE users ADD COLUMN IF NOT EXISTS requested_role user_role;

ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_status approval_status NOT NULL DEFAULT 'approved';

-- Who granted it and when. Not decoration: this is a privilege escalation, and
-- it is the one action on this platform that must leave a trace naming the
-- person who performed it. It is also the first row of the audit log the project
-- already wants (PRD → NFR-5), which is why it is shaped as a real reference
-- rather than a JSON blob.
--
-- SET NULL rather than CASCADE: an admin leaving must not delete the record of
-- the approvals they granted.
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;

-- Why it was refused, in the admin's own words, so the email the applicant gets
-- says something they can act on instead of "no".
ALTER TABLE users ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- The only read this adds to a hot path: "is there anything waiting for me",
-- asked on every load of the users tab. PARTIAL, because the answer is almost
-- always a handful of rows out of the whole membership — a full index on a
-- column that is 'approved' for practically every row would be mostly dead
-- weight, and Postgres would ignore it anyway.
CREATE INDEX IF NOT EXISTS idx_users_approval ON users(approval_status)
  WHERE approval_status = 'pending';
