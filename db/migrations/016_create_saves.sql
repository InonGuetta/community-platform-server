-- Saving, which is a different act from liking and therefore a different table.
--
-- A like is an opinion about a lecture ("this was good"), and the likes page is
-- a public-facing record of it. A save is a personal filing decision ("I want
-- this back later"), and the two do not move together: a student saves a lecture
-- they have not heard yet, and likes one they may never return to. Folding them
-- into one row with a flag would have made every future query ask "which kind of
-- row is this", for two things that share only a shape.
--
-- Everything here is IF NOT EXISTS because db/migrate.js re-runs every file on
-- every invocation and only skips a statement when Postgres answers "already
-- exists".

-- The general save: one flat list per user, and the state the save button reads.
CREATE TABLE IF NOT EXISTS saved_items (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id INT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  -- Same reasoning as likes: there is nothing to edit about a save, only to add
  -- or remove one. The UNIQUE is what lets the service use ON CONFLICT DO
  -- NOTHING, so a double-click or the same lecture open in two tabs cannot
  -- leave two rows behind.
  UNIQUE (user_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_items_user_created ON saved_items(user_id, created_at DESC);

-- A list of lessons the user assembles themselves ("רשימת שיעורים").
--
-- Owned by a user rather than shared: these are private filing, not published
-- collections. A shared/curated list is a different feature with different
-- permissions, and building this one as if it might become that would mean
-- carrying a visibility column nothing reads.
CREATE TABLE IF NOT EXISTS playlists (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 120 is TITLE_MAX in services/servicesSaves.js, which rejects anything longer
  -- with a 400 before it reaches here. The two must move together: a column
  -- narrower than that check turns a clear error message into a driver failure.
  title VARCHAR(120) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  -- Per user, not global — two students may both have a "לשבת". Within one
  -- user, two lists of the same name are only ever a mistake: the save menu
  -- shows nothing but the title, so a duplicate is a coin toss every time.
  UNIQUE (user_id, title)
);

CREATE INDEX IF NOT EXISTS idx_playlists_user_created ON playlists(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS playlist_items (
  id SERIAL PRIMARY KEY,
  playlist_id INT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id INT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  added_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (playlist_id, media_id)
);

CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist ON playlist_items(playlist_id, added_at DESC);
-- Reached from the media side too: removing the general save clears that
-- lecture out of every list the user has, which is a lookup by media_id.
CREATE INDEX IF NOT EXISTS idx_playlist_items_media ON playlist_items(media_id);
