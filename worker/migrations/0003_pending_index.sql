-- Make "which printings still need a fingerprint" a cheap indexed seek.
--
-- /admin/pending-fingerprints filters `WHERE game_id = ? AND fingerprinted_at
-- IS NULL`. The existing printings_pending index is on fingerprinted_at alone,
-- which does not narrow at all while nothing is fingerprinted yet (every row is
-- NULL), so the query scans the whole printings table (~34k rows) on every
-- call. Via the Workers D1 binding that scan is large enough to fail the
-- request. A composite index on (game_id, fingerprinted_at) lets D1 seek
-- straight to one game's un-fingerprinted rows.
CREATE INDEX IF NOT EXISTS printings_game_pending ON printings (game_id, fingerprinted_at);
