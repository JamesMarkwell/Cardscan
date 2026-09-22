-- Catalog schema. Mirrors the app's local SQLite so a pack can be applied as-is.

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tcgcsv_category_id INTEGER,
  cardmarket_game_id INTEGER
);

CREATE TABLE IF NOT EXISTS sets (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games (id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  release_date TEXT,
  card_count INTEGER,
  tcgcsv_group_id INTEGER,
  cardmarket_expansion_id INTEGER
);
CREATE INDEX IF NOT EXISTS sets_game ON sets (game_id);

-- One row per distinct artwork. art_id is what a scan matches.
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games (id),
  name TEXT NOT NULL,
  art_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_art ON cards (art_id);

CREATE TABLE IF NOT EXISTS printings (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards (id),
  game_id TEXT NOT NULL,
  set_id TEXT NOT NULL REFERENCES sets (id),
  number TEXT NOT NULL,
  set_total TEXT,
  rarity TEXT,
  variant TEXT NOT NULL DEFAULT 'normal',
  language TEXT NOT NULL DEFAULT 'en',
  tcgplayer_product_id INTEGER,
  cardmarket_product_id INTEGER,
  scryfall_id TEXT,
  image_key TEXT,
  image_url TEXT,
  fingerprinted_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS printings_card ON printings (card_id);
CREATE INDEX IF NOT EXISTS printings_set ON printings (set_id);
CREATE INDEX IF NOT EXISTS printings_pending ON printings (fingerprinted_at);

CREATE TABLE IF NOT EXISTS prices_latest (
  printing_id TEXT NOT NULL REFERENCES printings (id),
  source TEXT NOT NULL,
  currency TEXT NOT NULL,
  market REAL,
  low REAL,
  trend REAL,
  avg7 REAL,
  avg30 REAL,
  as_of TEXT NOT NULL,
  PRIMARY KEY (printing_id, source)
);

CREATE TABLE IF NOT EXISTS catalog_versions (
  game_id TEXT NOT NULL,
  version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  printings_count INTEGER NOT NULL,
  index_pack_key TEXT,
  PRIMARY KEY (game_id, version)
);

-- Rows we could not match across sources. Logged rather than guessed at.
CREATE TABLE IF NOT EXISTS unmatched (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL,
  reason TEXT NOT NULL,
  seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  detail TEXT
);

INSERT OR IGNORE INTO games (id, name, tcgcsv_category_id, cardmarket_game_id) VALUES
  ('onepiece', 'One Piece', 68, 19),
  ('pokemon', 'Pokémon', 3, 6),
  ('mtg', 'Magic: The Gathering', 1, 1),
  ('yugioh', 'Yu-Gi-Oh!', 2, 3),
  ('lorcana', 'Lorcana', 71, 20);
