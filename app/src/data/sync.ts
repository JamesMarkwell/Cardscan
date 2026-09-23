/**
 * Catalog sync.
 *
 * The Worker publishes a manifest naming the current version per game plus the
 * files to fetch. First install pulls a full catalog; after that only the daily
 * delta. Everything is content-addressed by version, so a half-finished sync
 * just gets retried rather than leaving a mixed catalog behind.
 */
import * as SQLite from 'expo-sqlite';
import { openDatabase } from './db';
import { saveIndexPack } from './indexPack';
import { GameId } from './types';

export interface GameManifest {
  game: GameId;
  version: string;
  printingsCount: number;
  catalogUrl: string;
  // Present only once the fingerprint job has published a scan index for this
  // version. Absent until then — the catalog still syncs, scanning waits.
  indexUrl?: string;
  indexIdsUrl?: string;
  deltas: Array<{ from: string; to: string; url: string }>;
}

export interface Manifest {
  version: string;
  generatedAt: string;
  games: GameManifest[];
}

export interface CatalogDelta {
  from: string;
  to: string;
  sets?: Array<Record<string, unknown>>;
  cards?: Array<Record<string, unknown>>;
  printings?: Array<Record<string, unknown>>;
  prices?: Array<Record<string, unknown>>;
  removedPrintings?: string[];
}

export class SyncError extends Error {}

export async function fetchManifest(baseUrl: string, signal?: AbortSignal): Promise<Manifest> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/manifest.json`, { signal });
  if (!response.ok) throw new SyncError(`Manifest request failed: ${response.status}`);
  return (await response.json()) as Manifest;
}

export async function localVersion(gameId: GameId): Promise<string | null> {
  const db = await openDatabase();
  const row = await db.getFirstAsync<{ version: string }>(
    'SELECT version FROM catalog_version WHERE game_id = ?',
    [gameId],
  );
  return row?.version ?? null;
}

/** The delta chain from the installed version to the manifest version, if one exists. */
export function deltaPath(manifest: GameManifest, from: string | null): GameManifest['deltas'] {
  if (!from || from === manifest.version) return [];

  const byFrom = new Map(manifest.deltas.map((delta) => [delta.from, delta]));
  const chain: GameManifest['deltas'] = [];
  let cursor = from;

  while (cursor !== manifest.version) {
    const next = byFrom.get(cursor);
    if (!next) return [];
    chain.push(next);
    cursor = next.to;
    if (chain.length > 64) return [];
  }

  return chain;
}

export async function applyDelta(delta: CatalogDelta): Promise<void> {
  const db = await openDatabase();
  await db.withTransactionAsync(async () => {
    await upsertSets(db, delta.sets ?? []);
    await upsertCards(db, delta.cards ?? []);
    await upsertPrintings(db, delta.printings ?? []);
    await upsertPrices(db, delta.prices ?? []);

    for (const id of delta.removedPrintings ?? []) {
      await db.runAsync('DELETE FROM printings WHERE id = ?', [id]);
    }
  });
}

async function upsertSets(db: SQLite.SQLiteDatabase, rows: Array<Record<string, any>>): Promise<void> {
  for (const row of rows) {
    await db.runAsync(
      `INSERT INTO sets (id, game_id, code, name, release_date, card_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET code = excluded.code, name = excluded.name,
         release_date = excluded.release_date, card_count = excluded.card_count`,
      [row.id, row.gameId, row.code, row.name, row.releaseDate ?? null, row.cardCount ?? null],
    );
  }
}

async function upsertCards(db: SQLite.SQLiteDatabase, rows: Array<Record<string, any>>): Promise<void> {
  for (const row of rows) {
    await db.runAsync(
      `INSERT INTO cards (id, game_id, name, art_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, art_id = excluded.art_id`,
      [row.id, row.gameId, row.name, row.artId],
    );
  }
}

async function upsertPrintings(db: SQLite.SQLiteDatabase, rows: Array<Record<string, any>>): Promise<void> {
  for (const row of rows) {
    await db.runAsync(
      `INSERT INTO printings (id, card_id, game_id, set_id, number, set_total, rarity, variant,
                              language, image_key, tcgplayer_product_id, cardmarket_product_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         set_id = excluded.set_id, number = excluded.number, set_total = excluded.set_total,
         rarity = excluded.rarity, variant = excluded.variant, language = excluded.language,
         image_key = excluded.image_key, tcgplayer_product_id = excluded.tcgplayer_product_id,
         cardmarket_product_id = excluded.cardmarket_product_id, updated_at = excluded.updated_at`,
      [
        row.id,
        row.cardId,
        row.gameId,
        row.setId,
        row.number,
        row.setTotal ?? null,
        row.rarity ?? null,
        row.variant ?? 'normal',
        row.language ?? 'en',
        row.imageKey ?? null,
        row.tcgplayerProductId ?? null,
        row.cardmarketProductId ?? null,
        row.updatedAt ?? new Date().toISOString(),
      ],
    );
  }
}

async function upsertPrices(db: SQLite.SQLiteDatabase, rows: Array<Record<string, any>>): Promise<void> {
  for (const row of rows) {
    await db.runAsync(
      `INSERT INTO prices_latest (printing_id, source, currency, market, low, trend, avg7, avg30, as_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (printing_id, source) DO UPDATE SET
         currency = excluded.currency, market = excluded.market, low = excluded.low,
         trend = excluded.trend, avg7 = excluded.avg7, avg30 = excluded.avg30, as_of = excluded.as_of`,
      [
        row.printingId,
        row.source,
        row.currency,
        row.market ?? null,
        row.low ?? null,
        row.trend ?? null,
        row.avg7 ?? null,
        row.avg30 ?? null,
        row.asOf,
      ],
    );
  }
}

async function setVersion(gameId: GameId, version: string, count: number): Promise<void> {
  const db = await openDatabase();
  await db.runAsync(
    `INSERT INTO catalog_version (game_id, version, printings_count, synced_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (game_id) DO UPDATE SET version = excluded.version,
       printings_count = excluded.printings_count, synced_at = excluded.synced_at`,
    [gameId, version, count, new Date().toISOString()],
  );
}

export interface SyncProgress {
  stage: 'manifest' | 'catalog' | 'delta' | 'index' | 'done';
  game?: GameId;
  ratio?: number;
}

/**
 * Bring one game up to date. Returns true when anything changed.
 */
export async function syncGame(
  baseUrl: string,
  game: GameManifest,
  onProgress?: (progress: SyncProgress) => void,
): Promise<boolean> {
  const installed = await localVersion(game.game);
  if (installed === game.version) return false;

  const chain = deltaPath(game, installed);

  if (chain.length > 0) {
    let done = 0;
    for (const delta of chain) {
      const response = await fetch(delta.url);
      if (!response.ok) throw new SyncError(`Delta ${delta.from}->${delta.to} failed: ${response.status}`);
      await applyDelta((await response.json()) as CatalogDelta);
      done += 1;
      onProgress?.({ stage: 'delta', game: game.game, ratio: done / chain.length });
    }
  } else {
    // No usable delta chain (fresh install, or too far behind) — take the lot.
    onProgress?.({ stage: 'catalog', game: game.game, ratio: 0 });
    const response = await fetch(game.catalogUrl);
    if (!response.ok) throw new SyncError(`Catalog download failed: ${response.status}`);
    await applyDelta((await response.json()) as CatalogDelta);
    onProgress?.({ stage: 'catalog', game: game.game, ratio: 1 });
  }

  // The scan index is published by the fingerprint job, after and separately
  // from the catalog. It may not exist yet, so a missing or failed index must
  // not fail an otherwise-good catalog sync — scanning simply waits for it.
  if (game.indexUrl && game.indexIdsUrl) {
    onProgress?.({ stage: 'index', game: game.game, ratio: 0 });
    try {
      await saveIndexPack(game.game, game.version, game.indexUrl, game.indexIdsUrl);
      onProgress?.({ stage: 'index', game: game.game, ratio: 1 });
    } catch {
      // Index not available yet; the catalog is still synced below.
    }
  }

  await setVersion(game.game, game.version, game.printingsCount);
  return true;
}
