/**
 * Local catalog and collection database.
 *
 * The catalog is a copy of what the Worker publishes; the collection tables are
 * the user's own and are never overwritten by a sync.
 */
import * as SQLite from 'expo-sqlite';
import { CollectionEntry, Condition, GameId, Portfolio, Price, Printing, Variant } from './types';

const DATABASE_NAME = 'cardscan.db';

// A single shared connection. The open is cached as a *promise*, not the
// resolved handle, so callers that race (the mount effect, the launch auto-sync
// and the Settings button all open the DB) await the same open instead of each
// starting their own. Two opens would leave one SQLiteDatabase unreferenced;
// expo-sqlite then releases its native handle, and any query still holding that
// orphaned handle fails with "NativeDatabase.execAsync ... NullPointerException".
let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = (async () => {
      const db = await SQLite.openDatabaseAsync(DATABASE_NAME);
      await migrate(db);
      return db;
    })().catch((error) => {
      // Don't cache a failed open — let the next call retry from scratch.
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

export async function closeDatabase(): Promise<void> {
  const pending = databasePromise;
  databasePromise = null;
  const db = await pending?.catch(() => null);
  await db?.closeAsync();
}

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS sets (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      release_date TEXT,
      card_count INTEGER
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      name TEXT NOT NULL,
      art_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cards_art_id ON cards (art_id);

    CREATE TABLE IF NOT EXISTS printings (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      set_id TEXT NOT NULL,
      number TEXT NOT NULL,
      set_total TEXT,
      rarity TEXT,
      variant TEXT NOT NULL DEFAULT 'normal',
      language TEXT NOT NULL DEFAULT 'en',
      image_key TEXT,
      image_url TEXT,
      tcgplayer_product_id INTEGER,
      cardmarket_product_id INTEGER,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS printings_card_id ON printings (card_id);

    CREATE TABLE IF NOT EXISTS prices_latest (
      printing_id TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS portfolios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'GBP',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS collection (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL,
      printing_id TEXT NOT NULL,
      variant TEXT NOT NULL DEFAULT 'normal',
      condition TEXT NOT NULL DEFAULT 'NM',
      quantity INTEGER NOT NULL DEFAULT 1,
      cost_basis REAL,
      added_at TEXT NOT NULL,
      UNIQUE (portfolio_id, printing_id, variant, condition)
    );

    CREATE TABLE IF NOT EXISTS catalog_version (
      game_id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      printings_count INTEGER NOT NULL,
      synced_at TEXT NOT NULL
    );

    -- Corrections the user makes are kept so the model can be tuned later.
    CREATE TABLE IF NOT EXISTS scan_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      predicted_art_id TEXT,
      corrected_printing_id TEXT NOT NULL,
      embedding BLOB,
      created_at TEXT NOT NULL
    );
  `);

  // Databases made before card pictures were kept have no image_url column. Add it,
  // and forget the synced catalogue versions so the next sync fetches every card
  // again with its picture. (Fails harmlessly when the column already exists.)
  try {
    await db.execAsync('ALTER TABLE printings ADD COLUMN image_url TEXT');
    await db.execAsync('DELETE FROM catalog_version');
  } catch {
    // Already present.
  }

  const existing = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM portfolios');
  if (!existing || existing.count === 0) {
    await db.runAsync('INSERT INTO portfolios (name, currency, created_at) VALUES (?, ?, ?)', [
      'My collection',
      'GBP',
      new Date().toISOString(),
    ]);
  }
}

interface PrintingRow {
  id: string;
  card_id: string;
  game_id: string;
  name: string;
  set_id: string;
  set_code: string;
  set_name: string;
  number: string;
  set_total: string | null;
  rarity: string | null;
  variant: string;
  language: string;
  image_key: string | null;
  image_url?: string | null;
  tcgplayer_product_id: number | null;
  cardmarket_product_id: number | null;
}

function toPrinting(row: PrintingRow): Printing {
  return {
    id: row.id,
    cardId: row.card_id,
    gameId: row.game_id as GameId,
    name: row.name,
    setId: row.set_id,
    setCode: row.set_code,
    setName: row.set_name,
    number: row.number,
    setTotal: row.set_total,
    rarity: row.rarity,
    variant: row.variant as Variant,
    language: row.language,
    imageKey: row.image_key,
    imageUrl: row.image_url ?? null,
    tcgplayerProductId: row.tcgplayer_product_id,
    cardmarketProductId: row.cardmarket_product_id,
  };
}

const PRINTING_SELECT = `
  SELECT p.id, p.card_id, p.game_id, c.name AS name, p.set_id,
         s.code AS set_code, s.name AS set_name, p.number, p.set_total, p.rarity,
         p.variant, p.language, p.image_key, p.image_url, p.tcgplayer_product_id, p.cardmarket_product_id
  FROM printings p
  JOIN cards c ON c.id = p.card_id
  JOIN sets s ON s.id = p.set_id
`;

/** Every printing that shares an artwork — the set a scan has to choose between. */
export async function printingsForArt(artId: string): Promise<Printing[]> {
  const db = await openDatabase();
  const rows = await db.getAllAsync<PrintingRow>(
    `${PRINTING_SELECT} WHERE c.art_id = ? ORDER BY s.release_date DESC, p.number ASC`,
    [artId],
  );
  return rows.map(toPrinting);
}

/**
 * Resolve one row of the scan index to the printings a scan has to choose between.
 *
 * The index is keyed by printing id — the fingerprint job embeds one image per
 * printing and writes that printing's id against the row — not by art id, which
 * is what {@link printingsForArt} takes. Looking a row's id up as an art id finds
 * nothing, which is how a good match used to come back as "no match". So find the
 * printing the row belongs to, then every printing that shares its artwork, with
 * the matched printing first. Null when the printing isn't in the local catalogue.
 */
export async function printingsForIndexRow(
  rowId: string,
): Promise<{ artId: string; printings: Printing[] } | null> {
  const db = await openDatabase();
  const match = await db.getFirstAsync<{ art_id: string }>(
    'SELECT c.art_id AS art_id FROM printings p JOIN cards c ON c.id = p.card_id WHERE p.id = ?',
    [rowId],
  );
  if (!match) return null;

  const printings = await printingsForArt(match.art_id);
  const matched = printings.findIndex((printing) => printing.id === rowId);
  if (matched > 0) printings.unshift(...printings.splice(matched, 1));
  return { artId: match.art_id, printings };
}

/**
 * Every printing of a game that carries a given printed serial — "OP17-070" for
 * One Piece. A serial pins the card down almost exactly, so this is a handful of
 * rows: the original, reprints in other sets, foil and alternate-art versions.
 */
export async function printingsBySerial(gameId: GameId, serial: string): Promise<Printing[]> {
  const db = await openDatabase();
  const rows = await db.getAllAsync<PrintingRow>(
    `${PRINTING_SELECT} WHERE p.game_id = ? AND p.number = ? ORDER BY s.release_date DESC, p.id ASC`,
    [gameId, serial],
  );
  return rows.map(toPrinting);
}

/**
 * Printings whose serial matches any of the given SQL LIKE patterns — the serial
 * that was read and the ones a digit away from it (see nearSerialPatterns), so a
 * misread digit can still be resolved by the rest of the evidence.
 */
export async function printingsMatchingSerials(gameId: GameId, patterns: string[]): Promise<Printing[]> {
  if (patterns.length === 0) return [];
  const db = await openDatabase();
  const clauses = patterns.map(() => 'p.number LIKE ?').join(' OR ');
  const rows = await db.getAllAsync<PrintingRow>(
    `${PRINTING_SELECT} WHERE p.game_id = ? AND (${clauses}) ORDER BY s.release_date DESC, p.id ASC LIMIT 400`,
    [gameId, ...patterns],
  );
  return rows.map(toPrinting);
}

export async function printingById(id: string): Promise<Printing | null> {
  const db = await openDatabase();
  const row = await db.getFirstAsync<PrintingRow>(`${PRINTING_SELECT} WHERE p.id = ?`, [id]);
  return row ? toPrinting(row) : null;
}

export async function searchPrintingsByName(query: string, limit = 50): Promise<Printing[]> {
  const db = await openDatabase();
  const rows = await db.getAllAsync<PrintingRow>(
    `${PRINTING_SELECT} WHERE c.name LIKE ? ORDER BY c.name LIMIT ?`,
    [`%${query}%`, limit],
  );
  return rows.map(toPrinting);
}

export async function pricesFor(printingId: string): Promise<Price[]> {
  const db = await openDatabase();
  const rows = await db.getAllAsync<{
    printing_id: string;
    source: string;
    currency: string;
    market: number | null;
    low: number | null;
    trend: number | null;
    avg7: number | null;
    avg30: number | null;
    as_of: string;
  }>('SELECT * FROM prices_latest WHERE printing_id = ?', [printingId]);

  return rows.map((row) => ({
    printingId: row.printing_id,
    source: row.source as Price['source'],
    currency: row.currency,
    market: row.market,
    low: row.low,
    trend: row.trend,
    avg7: row.avg7,
    avg30: row.avg30,
    asOf: row.as_of,
  }));
}

export async function defaultPortfolio(): Promise<Portfolio> {
  const db = await openDatabase();
  const row = await db.getFirstAsync<{ id: number; name: string; currency: string; created_at: string }>(
    'SELECT * FROM portfolios ORDER BY id LIMIT 1',
  );
  if (!row) throw new Error('No portfolio');
  return { id: row.id, name: row.name, currency: row.currency, createdAt: row.created_at };
}

/** Add to the collection, or bump the quantity if that exact row already exists. */
export async function addToCollection(params: {
  portfolioId: number;
  printingId: string;
  variant: Variant;
  condition: Condition;
  quantity?: number;
  costBasis?: number | null;
}): Promise<void> {
  const db = await openDatabase();
  await db.runAsync(
    `INSERT INTO collection (portfolio_id, printing_id, variant, condition, quantity, cost_basis, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (portfolio_id, printing_id, variant, condition)
     DO UPDATE SET quantity = quantity + excluded.quantity`,
    [
      params.portfolioId,
      params.printingId,
      params.variant,
      params.condition,
      params.quantity ?? 1,
      params.costBasis ?? null,
      new Date().toISOString(),
    ],
  );
}

export interface CollectionRow extends CollectionEntry {
  printing: Printing;
  market: number | null;
  currency: string | null;
}

export async function collectionRows(portfolioId: number): Promise<CollectionRow[]> {
  const db = await openDatabase();
  const rows = await db.getAllAsync<PrintingRow & {
    entry_id: number;
    portfolio_id: number;
    entry_variant: string;
    condition: string;
    quantity: number;
    cost_basis: number | null;
    added_at: string;
    market: number | null;
    price_currency: string | null;
  }>(
    `SELECT e.id AS entry_id, e.portfolio_id, e.variant AS entry_variant, e.condition, e.quantity,
            e.cost_basis, e.added_at,
            pr.market AS market, pr.currency AS price_currency,
            p.id, p.card_id, p.game_id, c.name AS name, p.set_id, s.code AS set_code,
            s.name AS set_name, p.number, p.set_total, p.rarity, p.variant, p.language,
            p.image_key, p.image_url, p.tcgplayer_product_id, p.cardmarket_product_id
     FROM collection e
     JOIN printings p ON p.id = e.printing_id
     JOIN cards c ON c.id = p.card_id
     JOIN sets s ON s.id = p.set_id
     LEFT JOIN prices_latest pr ON pr.printing_id = p.id AND pr.source = 'cardmarket'
     WHERE e.portfolio_id = ?
     ORDER BY e.added_at DESC`,
    [portfolioId],
  );

  return rows.map((row) => ({
    id: row.entry_id,
    portfolioId: row.portfolio_id,
    printingId: row.id,
    variant: row.entry_variant as Variant,
    condition: row.condition as Condition,
    quantity: row.quantity,
    costBasis: row.cost_basis,
    addedAt: row.added_at,
    printing: toPrinting(row),
    market: row.market,
    currency: row.price_currency,
  }));
}

export async function recordCorrection(
  predictedArtId: string | null,
  correctedPrintingId: string,
  embedding: Float32Array | null,
): Promise<void> {
  const db = await openDatabase();
  await db.runAsync(
    'INSERT INTO scan_corrections (predicted_art_id, corrected_printing_id, embedding, created_at) VALUES (?, ?, ?, ?)',
    [
      predictedArtId,
      correctedPrintingId,
      embedding ? new Uint8Array(embedding.buffer.slice(0)) : null,
      new Date().toISOString(),
    ],
  );
}

/** Change a collection row's quantity, condition or variant. */
export async function updateCollectionEntry(
  id: number,
  changes: { quantity?: number; condition?: Condition; variant?: Variant },
): Promise<void> {
  const db = await openDatabase();
  await db.withTransactionAsync(async () => {
    const current = await db.getFirstAsync<{
      portfolio_id: number;
      printing_id: string;
      variant: string;
      condition: string;
      quantity: number;
    }>('SELECT portfolio_id, printing_id, variant, condition, quantity FROM collection WHERE id = ?', [id]);
    if (!current) return;

    const variant = changes.variant ?? current.variant;
    const condition = changes.condition ?? current.condition;
    const quantity = Math.max(1, changes.quantity ?? current.quantity);

    // Changing to a variant/condition already in the collection merges into that row.
    const other = await db.getFirstAsync<{ id: number }>(
      `SELECT id FROM collection
       WHERE portfolio_id = ? AND printing_id = ? AND variant = ? AND condition = ? AND id <> ?`,
      [current.portfolio_id, current.printing_id, variant, condition, id],
    );
    if (other) {
      await db.runAsync('UPDATE collection SET quantity = quantity + ? WHERE id = ?', [quantity, other.id]);
      await db.runAsync('DELETE FROM collection WHERE id = ?', [id]);
      return;
    }
    await db.runAsync('UPDATE collection SET variant = ?, condition = ?, quantity = ? WHERE id = ?', [
      variant,
      condition,
      quantity,
      id,
    ]);
  });
}

export async function removeFromCollection(id: number): Promise<void> {
  const db = await openDatabase();
  await db.runAsync('DELETE FROM collection WHERE id = ?', [id]);
}

export interface PrintingResult extends Printing {
  market: number | null;
  currency: string | null;
}

/**
 * Find printings to add by hand. Every word must match somewhere in the card's
 * name, number, or set (code or name), so "charizard base" or "OP17 070" both work.
 * Whole-name prefix matches come first.
 */
export async function searchPrintings(params: {
  query: string;
  gameId?: GameId | null;
  limit?: number;
  offset?: number;
}): Promise<PrintingResult[]> {
  const terms = params.query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const db = await openDatabase();
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (params.gameId) {
    where.push('p.game_id = ?');
    args.push(params.gameId);
  }
  for (const term of terms) {
    where.push('(c.name LIKE ? OR p.number LIKE ? OR s.code LIKE ? OR s.name LIKE ?)');
    const like = `%${term}%`;
    args.push(like, like, like, like);
  }

  const rows = await db.getAllAsync<PrintingRow & { market: number | null; price_currency: string | null }>(
    `SELECT p.id, p.card_id, p.game_id, c.name AS name, p.set_id, s.code AS set_code, s.name AS set_name,
            p.number, p.set_total, p.rarity, p.variant, p.language, p.image_key, p.image_url,
            p.tcgplayer_product_id, p.cardmarket_product_id,
            pr.market AS market, pr.currency AS price_currency
     FROM printings p
     JOIN cards c ON c.id = p.card_id
     JOIN sets s ON s.id = p.set_id
     LEFT JOIN prices_latest pr ON pr.printing_id = p.id AND pr.source = 'cardmarket'
     WHERE ${where.join(' AND ')}
     ORDER BY (c.name LIKE ?) DESC, c.name ASC, s.release_date DESC, p.number ASC
     LIMIT ? OFFSET ?`,
    [...args, `${terms[0]}%`, params.limit ?? 40, params.offset ?? 0],
  );
  return rows.map((row) => ({ ...toPrinting(row), market: row.market, currency: row.price_currency }));
}
