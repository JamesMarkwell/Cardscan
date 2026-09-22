/**
 * Importing a game's catalog into D1 and publishing packs to R2.
 */
import { extended, fetchGroups, fetchPrices, fetchProducts, FetchOptions, TcgGroup, TCGCSV_CATEGORY } from './sources';
import { matchKey, normaliseName, parseMoney, printingId, setId, splitNumber, variantFromProductName } from './normalise';
import { CatalogDelta, Env, GameId, PriceRow, PrintingRow } from './types';

export interface ImportReport {
  game: GameId;
  sets: number;
  printings: number;
  prices: number;
  unmatched: number;
}

/** Version stamp for a publish — date plus a counter keeps them sortable. */
export function nextVersion(now = new Date()): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

function emptyReport(game: GameId): ImportReport {
  return { game, sets: 0, printings: 0, prices: 0, unmatched: 0 };
}

/**
 * Sets in a stable order so a batched import can resume by index. TCGCSV does
 * not promise an order, and group ids are stable, so we sort by them: a set
 * that appears later keeps the same position for earlier ones.
 */
function orderedGroups(groups: TcgGroup[]): TcgGroup[] {
  return [...groups].sort((a, b) => a.groupId - b.groupId);
}

/** Import all of a game's sets in one pass. Used by tests and full local runs. */
export async function importGame(env: Env, game: GameId, options: FetchOptions): Promise<ImportReport> {
  const categoryId = TCGCSV_CATEGORY[game];
  const groups = orderedGroups(await fetchGroups(categoryId, options));
  const report = emptyReport(game);
  await importGroups(env, game, groups, options, report);
  return report;
}

/**
 * Import one slice of a game's sets, starting at `cursor`. Returns how many
 * sets there are in total and the cursor to resume from, so a caller can drive
 * the import a batch per Worker invocation and stay under the subrequest limit.
 */
export async function importGameBatch(
  env: Env,
  game: GameId,
  options: FetchOptions,
  cursor: number,
  batchSize: number,
): Promise<{ report: ImportReport; total: number; nextCursor: number }> {
  const categoryId = TCGCSV_CATEGORY[game];
  const groups = orderedGroups(await fetchGroups(categoryId, options));
  const slice = groups.slice(cursor, cursor + batchSize);
  const report = emptyReport(game);
  await importGroups(env, game, slice, options, report);
  return { report, total: groups.length, nextCursor: cursor + slice.length };
}

/** The per-set work, shared by the full and batched imports. */
async function importGroups(
  env: Env,
  game: GameId,
  groups: TcgGroup[],
  options: FetchOptions,
  report: ImportReport,
): Promise<void> {
  const categoryId = TCGCSV_CATEGORY[game];
  const now = new Date().toISOString();

  for (const group of groups) {
    const code = group.abbreviation ?? String(group.groupId);
    const set = setId(game, code);

    await env.DB.prepare(
      `INSERT INTO sets (id, game_id, code, name, release_date, tcgcsv_group_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, release_date = excluded.release_date,
         tcgcsv_group_id = excluded.tcgcsv_group_id`,
    )
      .bind(set, game, code, group.name, group.publishedOn, group.groupId)
      .run();
    report.sets += 1;

    const products = await fetchProducts(categoryId, group.groupId, options);
    const statements: D1PreparedStatement[] = [];

    for (const product of products) {
      const rawNumber = extended(product, 'Number');
      if (!rawNumber) {
        // Sealed product and anything without a collector number is not a card.
        statements.push(
          env.DB.prepare(
            'INSERT INTO unmatched (game_id, source, payload, reason, seen_at) VALUES (?, ?, ?, ?, ?)',
          ).bind(game, 'tcgcsv', JSON.stringify({ productId: product.productId, name: product.name }), 'no-number', now),
        );
        report.unmatched += 1;
        continue;
      }

      const { number, total } = splitNumber(rawNumber);
      const variant = variantFromProductName(product.name);
      const rarity = extended(product, 'Rarity');

      // Artwork identity: same name and number inside a set means the same art.
      // Reprints across sets are linked by the ml job when fingerprints collide.
      const artId = `${game}:${normaliseName(product.cleanName || product.name)}:${matchKey(code, number, product.cleanName || product.name)}`;
      const cardId = `${game}:${normaliseName(product.cleanName || product.name)}`;
      const id = printingId(game, code, number, variant, 'en');

      statements.push(
        env.DB.prepare(
          `INSERT INTO cards (id, game_id, name, art_id) VALUES (?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name`,
        ).bind(cardId, game, product.cleanName || product.name, artId),
        env.DB.prepare(
          `INSERT INTO printings (id, card_id, game_id, set_id, number, set_total, rarity, variant,
                                  language, tcgplayer_product_id, image_url, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'en', ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET rarity = excluded.rarity, set_total = excluded.set_total,
             tcgplayer_product_id = excluded.tcgplayer_product_id, image_url = excluded.image_url,
             updated_at = excluded.updated_at`,
        ).bind(id, cardId, game, set, number, total, rarity, variant, product.productId, product.imageUrl, now),
      );
      report.printings += 1;
    }

    if (statements.length > 0) await env.DB.batch(statements);

    const prices = await fetchPrices(categoryId, group.groupId, options);
    const priceStatements = prices
      .map((price) => {
        const market = parseMoney(price.marketPrice);
        const low = parseMoney(price.lowPrice);
        if (market === null && low === null) return null;
        return env.DB.prepare(
          `INSERT INTO prices_latest (printing_id, source, currency, market, low, trend, avg7, avg30, as_of)
           SELECT id, 'tcgplayer', 'USD', ?, ?, NULL, NULL, NULL, ?
           FROM printings WHERE tcgplayer_product_id = ?
           ON CONFLICT (printing_id, source) DO UPDATE SET market = excluded.market,
             low = excluded.low, as_of = excluded.as_of`,
        ).bind(market, low, now, price.productId);
      })
      .filter((statement): statement is D1PreparedStatement => statement !== null);

    if (priceStatements.length > 0) {
      await env.DB.batch(priceStatements);
      report.prices += priceStatements.length;
    }
  }
}

/** Everything the app needs for a first install of one game. */
export async function buildFullDelta(env: Env, game: GameId, version: string): Promise<CatalogDelta> {
  const sets = await env.DB.prepare(
    'SELECT id, game_id AS gameId, code, name, release_date AS releaseDate, card_count AS cardCount FROM sets WHERE game_id = ?',
  )
    .bind(game)
    .all();

  const cards = await env.DB.prepare('SELECT id, game_id AS gameId, name, art_id AS artId FROM cards WHERE game_id = ?')
    .bind(game)
    .all();

  const printings = await env.DB.prepare(
    `SELECT id, card_id AS cardId, game_id AS gameId, set_id AS setId, number, set_total AS setTotal,
            rarity, variant, language, tcgplayer_product_id AS tcgplayerProductId,
            cardmarket_product_id AS cardmarketProductId, image_key AS imageKey, image_url AS imageUrl,
            updated_at AS updatedAt
     FROM printings WHERE game_id = ?`,
  )
    .bind(game)
    .all();

  const prices = await env.DB.prepare(
    `SELECT p.printing_id AS printingId, p.source, p.currency, p.market, p.low, p.trend, p.avg7, p.avg30, p.as_of AS asOf
     FROM prices_latest p JOIN printings r ON r.id = p.printing_id WHERE r.game_id = ?`,
  )
    .bind(game)
    .all();

  return {
    from: '',
    to: version,
    sets: sets.results as unknown as CatalogDelta['sets'],
    cards: cards.results as unknown as CatalogDelta['cards'],
    printings: printings.results as unknown as PrintingRow[],
    prices: prices.results as unknown as PriceRow[],
    removedPrintings: [],
  };
}

/** Only what changed since the previous publish. */
export async function buildDelta(env: Env, game: GameId, from: string, to: string, since: string): Promise<CatalogDelta> {
  const printings = await env.DB.prepare(
    `SELECT id, card_id AS cardId, game_id AS gameId, set_id AS setId, number, set_total AS setTotal,
            rarity, variant, language, tcgplayer_product_id AS tcgplayerProductId,
            cardmarket_product_id AS cardmarketProductId, image_key AS imageKey, image_url AS imageUrl,
            updated_at AS updatedAt
     FROM printings WHERE game_id = ? AND updated_at > ?`,
  )
    .bind(game, since)
    .all();

  const prices = await env.DB.prepare(
    `SELECT p.printing_id AS printingId, p.source, p.currency, p.market, p.low, p.trend, p.avg7, p.avg30, p.as_of AS asOf
     FROM prices_latest p JOIN printings r ON r.id = p.printing_id
     WHERE r.game_id = ? AND p.as_of > ?`,
  )
    .bind(game, since)
    .all();

  const changedIds = new Set((printings.results as unknown as PrintingRow[]).map((row) => row.cardId));
  const cards = changedIds.size
    ? await env.DB.prepare(
        `SELECT id, game_id AS gameId, name, art_id AS artId FROM cards
         WHERE game_id = ? AND id IN (${[...changedIds].map(() => '?').join(',')})`,
      )
        .bind(game, ...changedIds)
        .all()
    : { results: [] };

  return {
    from,
    to,
    sets: [],
    cards: cards.results as unknown as CatalogDelta['cards'],
    printings: printings.results as unknown as PrintingRow[],
    prices: prices.results as unknown as PriceRow[],
    removedPrintings: [],
  };
}

export async function publishPack(env: Env, key: string, body: unknown): Promise<void> {
  await env.PACKS.put(key, JSON.stringify(body), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=86400, immutable' },
  });
}
