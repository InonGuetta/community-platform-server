-- Sessions that exist before they begin.
--
-- Until now createSession set started_at = NOW() and is_active = TRUE in the same
-- statement, so a session came into existence already running. That made the
-- whole WebRTC layer — the most intricate code in this application — almost
-- unusable in practice: a session existed only while its host had the tab open,
-- and a student had to happen to be looking at /sessions in exactly that window.
--
-- Everything here is IF NOT EXISTS because db/migrate.js re-runs every file on
-- every invocation and only skips a statement when Postgres answers "already
-- exists".

-- When the host means to hold it. NULL means "now", which is what every existing
-- row is and what the unscheduled path still creates — so no backfill is needed
-- and nothing that works today changes shape.
ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP;

-- started_at already existed and was always set at creation. It now carries the
-- distinction the feature needs: NULL means scheduled and not yet begun, a value
-- means somebody opened the room.
--
-- The three states are derived rather than stored as a status column, because
-- they are already implied by columns that must exist anyway, and a fourth
-- column would be a second source of truth for the same fact:
--
--   scheduled  started_at IS NULL     AND is_active
--   live       started_at IS NOT NULL AND is_active
--   ended      NOT is_active
--
-- is_active keeps its meaning — "not finished, not cancelled" — so ending a
-- scheduled session that never ran is the same operation as ending a live one.

-- The sessions list asks for upcoming and live separately, both ordered by time.
CREATE INDEX IF NOT EXISTS idx_live_sessions_scheduled
  ON live_sessions(scheduled_at)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_live_sessions_started
  ON live_sessions(started_at DESC)
  WHERE is_active;
