-- A new tag is proposed by a lecturer and enters the taxonomy only when an admin
-- approves it.
--
-- ── Why a table of its own and not a status column on tags ─────────────────
--
-- Every read of `tags` — the filter tree, the picker, the suggestions, the
-- counts — would have to learn to skip the pending rows, and the one that
-- forgot would show a tag nobody approved. Kept apart, a proposal cannot leak
-- into the vocabulary by omission: it becomes a row in `tags` only on approval.
--
-- ── Why the items are a separate table ──────────────────────────────────────
--
-- The item a proposal was made on is what gets the tag once it is approved —
-- that is the point of proposing it from the tagging dialog. Two lecturers
-- asking for the same tag under the same parent are ONE proposal (the partial
-- unique index below), and each of their items waits on it; a single media_id
-- column would drop the second item's claim.
--
-- Same approval_status enum as users (021): one vocabulary for "waiting".
CREATE TABLE IF NOT EXISTS tag_proposals (
  id SERIAL PRIMARY KEY,
  -- 60 is TAG_MAX in services/servicesTags.js, same pairing as tags.name.
  name VARCHAR(60) NOT NULL,
  -- NULL means a new root heading. CASCADE: a proposal to sit under a tag that
  -- no longer exists has nowhere to go, and approving it would create a root
  -- the lecturer did not ask for.
  parent_id INT REFERENCES tags(id) ON DELETE CASCADE,
  -- SET NULL: a lecturer leaving must not withdraw a proposal the admin may
  -- still want.
  proposed_by INT REFERENCES users(id) ON DELETE SET NULL,
  status approval_status NOT NULL DEFAULT 'pending',
  -- Who decided and when — the same trace 021 keeps for role approvals.
  decided_by INT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMP,
  rejection_reason TEXT,
  -- The tag an approval created. SET NULL: deleting the tag later must not
  -- delete the record that it was once approved.
  tag_id INT REFERENCES tags(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tag_proposals_parent ON tag_proposals(parent_id);
CREATE INDEX IF NOT EXISTS idx_tag_proposals_proposed_by ON tag_proposals(proposed_by);
CREATE INDEX IF NOT EXISTS idx_tag_proposals_decided_by ON tag_proposals(decided_by);
CREATE INDEX IF NOT EXISTS idx_tag_proposals_tag ON tag_proposals(tag_id);

-- One PENDING proposal per name per place. Only pending: once one is rejected
-- somebody may reasonably ask again, and once approved the tag itself exists
-- and the service refuses a duplicate before it gets here. COALESCE because a
-- NULL parent (a root) would otherwise never collide with another NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tag_proposals_pending_name
  ON tag_proposals (COALESCE(parent_id, 0), LOWER(name))
  WHERE status = 'pending';

-- "What is waiting" — the admin panel's read. Partial, as in 021.
CREATE INDEX IF NOT EXISTS idx_tag_proposals_status ON tag_proposals(status)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS tag_proposal_media (
  -- CASCADE both ways, as in media_tags: the pairing means nothing once either
  -- end is gone.
  proposal_id INT NOT NULL REFERENCES tag_proposals(id) ON DELETE CASCADE,
  media_id INT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  PRIMARY KEY (proposal_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_tag_proposal_media_media ON tag_proposal_media(media_id);
