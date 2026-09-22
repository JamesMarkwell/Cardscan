-- Resumable catalog imports.
--
-- A Cloudflare Worker invocation may make at most 50 outbound requests on the
-- free plan (1000 on paid). A full game import is one request for the set list
-- plus two per set (products + prices), so even a single mid-sized game blows
-- that budget in one invocation. The import is therefore run in batches of a
-- few sets at a time, and this table remembers where each game is up to so the
-- next invocation resumes rather than starting over. One row per game.

CREATE TABLE IF NOT EXISTS import_progress (
  game_id TEXT PRIMARY KEY REFERENCES games (id),
  run_id INTEGER,               -- the refresh_runs row this import belongs to
  cursor INTEGER NOT NULL DEFAULT 0,   -- next set index to process
  total INTEGER NOT NULL DEFAULT 0,    -- number of sets in the game
  sets INTEGER NOT NULL DEFAULT 0,     -- running totals, accumulated per batch
  printings INTEGER NOT NULL DEFAULT 0,
  prices INTEGER NOT NULL DEFAULT 0,
  unmatched INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  updated_at TEXT,
  done_at TEXT                  -- set when the last batch completes; NULL while running
);
