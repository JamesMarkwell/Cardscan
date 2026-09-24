/**
 * The catalog import, end to end, against a real SQLite database.
 *
 * This is the path that runs on the cron trigger and builds the card database,
 * so it is worth exercising for real: the migration, the upserts, the price
 * join, the pack that gets published to R2 and the delta a second run produces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDelta, buildFullDelta, importGame, importGameBatch, nextVersion } from '../src/catalog';
import { app, runRefresh, runRefreshStep } from '../src/index';
import { Env } from '../src/types';
import { LocalD1, LocalR2 } from './support/localD1';

const FIXTURES = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'tcgcsv-onepiece.json'), 'utf8'),
) as {
  groups: unknown;
  products: Record<string, unknown>;
  prices: Record<string, unknown>;
};

const MIGRATION = join(__dirname, '..', 'migrations', '0001_init.sql');
const MIGRATION_PROGRESS = join(__dirname, '..', 'migrations', '0002_import_progress.sql');
const OPTIONS = { userAgent: 'CardScan-test/0.1', minIntervalMs: 0 };

/** Serve the fixtures at the URLs the source adapter asks for. */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      const groups = path.match(/^\/tcgplayer\/\d+\/groups$/);
      const products = path.match(/^\/tcgplayer\/\d+\/(\d+)\/products$/);
      const prices = path.match(/^\/tcgplayer\/\d+\/(\d+)\/prices$/);

      let body: unknown;
      if (groups) body = FIXTURES.groups;
      else if (products) body = FIXTURES.products[products[1]];
      else if (prices) body = FIXTURES.prices[prices[1]];
      else return new Response('not found', { status: 404 });

      if (!body) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

describe('importGame', () => {
  let db: LocalD1;
  let packs: LocalR2;
  let env: Env;

  beforeEach(() => {
    db = new LocalD1();
    db.applyMigration(MIGRATION);
    packs = new LocalR2();
    env = {
      DB: db as unknown as D1Database,
      PACKS: packs as unknown as R2Bucket,
      USER_AGENT: 'CardScan-test/0.1',
      SOURCE_MIN_INTERVAL_MS: '0',
      PUBLIC_BASE_URL: 'https://cardscan.example',
    };
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('imports sets, cards, printings and prices', async () => {
    const report = await importGame(env, 'onepiece', OPTIONS);

    expect(report.sets).toBe(2);
    expect(report.printings).toBe(4);
    expect(db.count('sets')).toBe(2);
    expect(db.count('printings')).toBe(4);
  });

  it('skips products with no collector number and logs why', async () => {
    const report = await importGame(env, 'onepiece', OPTIONS);

    // The booster box is not a card.
    expect(report.unmatched).toBe(1);
    const unmatched = db.query<{ reason: string; payload: string }>('SELECT reason, payload FROM unmatched');
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].reason).toBe('no-number');
    expect(unmatched[0].payload).toContain('Booster Box');
  });

  it('splits a number over set total', async () => {
    await importGame(env, 'onepiece', OPTIONS);

    const uta = db.query<{ number: string; set_total: string | null }>(
      "SELECT number, set_total FROM printings WHERE tcgplayer_product_id = 556002",
    )[0];
    expect(uta.number).toBe('025');
    expect(uta.set_total).toBe('120');
  });

  it('reads the variant from the product name', async () => {
    await importGame(env, 'onepiece', OPTIONS);

    const variants = db.query<{ tcgplayer_product_id: number; variant: string }>(
      'SELECT tcgplayer_product_id, variant FROM printings ORDER BY tcgplayer_product_id',
    );
    expect(variants.find((row) => row.tcgplayer_product_id === 545002)?.variant).toBe('foil');
    expect(variants.find((row) => row.tcgplayer_product_id === 545001)?.variant).toBe('normal');
  });

  it('attaches prices to the right printings and ignores empty ones', async () => {
    await importGame(env, 'onepiece', OPTIONS);

    const prices = db.query<{ printing_id: string; market: number; currency: string }>(
      "SELECT printing_id, market, currency FROM prices_latest WHERE source = 'tcgplayer' ORDER BY market DESC",
    );

    // Four cards were imported and all four have a price. The booster box's
    // price and the price for a product id we never imported must not create
    // rows -- the join is what stops a sealed-product price being shown as a
    // card price.
    expect(prices).toHaveLength(4);
    expect(prices[0].market).toBeCloseTo(184.32, 2);
    expect(prices[0].currency).toBe('USD');
    expect(prices.every((row) => row.market !== null)).toBe(true);

    const foil = db.query<{ market: number }>(
      `SELECT pr.market FROM prices_latest pr
       JOIN printings p ON p.id = pr.printing_id
       WHERE p.tcgplayer_product_id = 545002`,
    )[0];
    expect(foil.market).toBeCloseTo(1.42, 2);
  });

  it('groups the two Luffy printings under one card but keeps them distinct', async () => {
    await importGame(env, 'onepiece', OPTIONS);

    const luffy = db.query<{ id: string; card_id: string; number: string }>(
      `SELECT p.id, p.card_id, p.number FROM printings p
       JOIN cards c ON c.id = p.card_id
       WHERE c.name = 'Monkey D Luffy' ORDER BY p.number`,
    );

    expect(luffy).toHaveLength(2);
    expect(luffy[0].card_id).toBe(luffy[1].card_id);
    expect(luffy[0].id).not.toBe(luffy[1].id);
  });

  it('is idempotent: a second run changes nothing', async () => {
    await importGame(env, 'onepiece', OPTIONS);
    const first = {
      sets: db.count('sets'),
      cards: db.count('cards'),
      printings: db.count('printings'),
      prices: db.count('prices_latest'),
    };

    await importGame(env, 'onepiece', OPTIONS);

    expect({
      sets: db.count('sets'),
      cards: db.count('cards'),
      printings: db.count('printings'),
      prices: db.count('prices_latest'),
    }).toEqual(first);
  });
});

describe('packs', () => {
  let db: LocalD1;
  let packs: LocalR2;
  let env: Env;

  beforeEach(async () => {
    db = new LocalD1();
    db.applyMigration(MIGRATION);
    packs = new LocalR2();
    env = {
      DB: db as unknown as D1Database,
      PACKS: packs as unknown as R2Bucket,
      USER_AGENT: 'CardScan-test/0.1',
      SOURCE_MIN_INTERVAL_MS: '0',
      PUBLIC_BASE_URL: 'https://cardscan.example',
    };
    stubFetch();
    await importGame(env, 'onepiece', OPTIONS);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds a full catalog the app can apply', async () => {
    const full = await buildFullDelta(env, 'onepiece', nextVersion());

    expect(full.sets).toHaveLength(2);
    expect(full.printings).toHaveLength(4);
    expect(full.prices.length).toBeGreaterThan(0);

    // The app reads these field names directly.
    const printing = full.printings[0];
    expect(printing).toHaveProperty('cardId');
    expect(printing).toHaveProperty('setId');
    expect(printing).toHaveProperty('setTotal');
    expect(printing).toHaveProperty('updatedAt');
    expect(full.prices[0]).toHaveProperty('printingId');
    expect(full.prices[0]).toHaveProperty('asOf');
  });

  it('builds a delta holding only what changed', async () => {
    const cutoff = new Date(Date.now() + 1000).toISOString();

    const empty = await buildDelta(env, 'onepiece', 'v1', 'v2', cutoff);
    expect(empty.printings).toHaveLength(0);
    expect(empty.cards).toHaveLength(0);

    const everything = await buildDelta(env, 'onepiece', 'v1', 'v2', '2000-01-01T00:00:00.000Z');
    expect(everything.printings).toHaveLength(4);
    expect(everything.cards.length).toBeGreaterThan(0);
  });

  it('serialises to JSON, which is how it reaches the phone', async () => {
    const full = await buildFullDelta(env, 'onepiece', nextVersion());
    const roundTripped = JSON.parse(JSON.stringify(full));
    expect(roundTripped.printings).toHaveLength(4);
  });
});

describe('runRefresh', () => {
  let db: LocalD1;
  let packs: LocalR2;
  let env: Env;

  beforeEach(() => {
    db = new LocalD1();
    db.applyMigration(MIGRATION);
    packs = new LocalR2();
    env = {
      DB: db as unknown as D1Database,
      PACKS: packs as unknown as R2Bucket,
      USER_AGENT: 'CardScan-test/0.1',
      SOURCE_MIN_INTERVAL_MS: '0',
      PUBLIC_BASE_URL: 'https://cardscan.example',
    };
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the database and publishes a catalog pack', async () => {
    const report = await runRefresh(env, ['onepiece']);

    expect(report.onepiece).toMatchObject({ game: 'onepiece', printings: 4 });

    const version = nextVersion();
    const key = `games/onepiece/catalog-${version}.json`;
    expect([...packs.objects.keys()]).toContain(key);

    const pack = packs.json<{ printings: unknown[]; prices: unknown[] }>(key);
    expect(pack.printings).toHaveLength(4);
    expect(pack.prices).toHaveLength(4);
  });

  it('records the run and the published version', async () => {
    await runRefresh(env, ['onepiece']);

    const runs = db.query<{ status: string; finished_at: string | null }>('SELECT status, finished_at FROM refresh_runs');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('ok');
    expect(runs[0].finished_at).not.toBeNull();

    const versions = db.query<{ game_id: string; printings_count: number }>('SELECT * FROM catalog_versions');
    expect(versions).toHaveLength(1);
    expect(versions[0].printings_count).toBe(4);
  });

  it('records a failed run rather than leaving it open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream down', { status: 503 })));

    await expect(runRefresh(env, ['onepiece'])).rejects.toThrow();

    const runs = db.query<{ status: string; detail: string }>('SELECT status, detail FROM refresh_runs');
    expect(runs[0].status).toBe('failed');
    expect(runs[0].detail).toContain('503');
    // Nothing half-imported should be published.
    expect(packs.objects.size).toBe(0);
  });
});

describe('importGameBatch', () => {
  let db: LocalD1;
  let env: Env;

  beforeEach(() => {
    db = new LocalD1();
    db.applyMigration(MIGRATION);
    env = {
      DB: db as unknown as D1Database,
      PACKS: new LocalR2() as unknown as R2Bucket,
      USER_AGENT: 'CardScan-test/0.1',
      SOURCE_MIN_INTERVAL_MS: '0',
      PUBLIC_BASE_URL: 'https://cardscan.example',
    };
    stubFetch();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('imports one slice of sets and reports the cursor to resume from', async () => {
    const first = await importGameBatch(env, 'onepiece', OPTIONS, 0, 1);
    expect(first.total).toBe(2);
    expect(first.nextCursor).toBe(1);
    expect(first.report.sets).toBe(1);
    expect(db.count('sets')).toBe(1);

    const second = await importGameBatch(env, 'onepiece', OPTIONS, first.nextCursor, 1);
    expect(second.nextCursor).toBe(2);
    expect(second.report.sets).toBe(1);
    expect(db.count('sets')).toBe(2);
    expect(db.count('printings')).toBe(4);
  });

  it('imports the same sets a full import would, in batches', async () => {
    let cursor = 0;
    let total = Infinity;
    while (cursor < total) {
      const step = await importGameBatch(env, 'onepiece', OPTIONS, cursor, 1);
      cursor = step.nextCursor;
      total = step.total;
    }
    expect(db.count('sets')).toBe(2);
    expect(db.count('printings')).toBe(4);
    expect(db.count('prices_latest')).toBe(4);
  });
});

describe('runRefreshStep', () => {
  let db: LocalD1;
  let packs: LocalR2;
  let env: Env;

  beforeEach(() => {
    db = new LocalD1();
    db.applyMigration(MIGRATION);
    db.applyMigration(MIGRATION_PROGRESS);
    packs = new LocalR2();
    env = {
      DB: db as unknown as D1Database,
      PACKS: packs as unknown as R2Bucket,
      USER_AGENT: 'CardScan-test/0.1',
      SOURCE_MIN_INTERVAL_MS: '0',
      PUBLIC_BASE_URL: 'https://cardscan.example',
    };
    stubFetch();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('publishes nothing until the final batch, then publishes once', async () => {
    // One set per batch, so the two-set fixture takes two calls.
    const first = await runRefreshStep(env, { game: 'onepiece', batchSize: 1 });
    expect(first.done).toBe(false);
    expect(first).toMatchObject({ cursor: 1, total: 2 });
    expect(packs.objects.size).toBe(0);
    expect(db.query<{ status: string }>('SELECT status FROM refresh_runs')[0].status).toBe('running');

    const second = await runRefreshStep(env, { game: 'onepiece', batchSize: 1 });
    expect(second.done).toBe(true);
    expect(second.report).toMatchObject({ game: 'onepiece', printings: 4 });

    const version = nextVersion();
    expect([...packs.objects.keys()]).toContain(`games/onepiece/catalog-${version}.json`);

    const runs = db.query<{ status: string; finished_at: string | null }>('SELECT status, finished_at FROM refresh_runs');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('ok');
    expect(runs[0].finished_at).not.toBeNull();

    const versions = db.query<{ printings_count: number }>('SELECT printings_count FROM catalog_versions');
    expect(versions).toHaveLength(1);
    expect(versions[0].printings_count).toBe(4);
  });

  it('records progress so a resumed run picks up the accumulated totals', async () => {
    await runRefreshStep(env, { game: 'onepiece', batchSize: 1 });
    const mid = db.query<{ cursor: number; printings: number; done_at: string | null }>(
      'SELECT cursor, printings, done_at FROM import_progress WHERE game_id = ?',
      'onepiece',
    )[0];
    expect(mid.cursor).toBe(1);
    expect(mid.printings).toBeGreaterThan(0);
    expect(mid.done_at).toBeNull();

    await runRefreshStep(env, { game: 'onepiece', batchSize: 1 });
    const end = db.query<{ cursor: number; printings: number; done_at: string | null }>(
      'SELECT cursor, printings, done_at FROM import_progress WHERE game_id = ?',
      'onepiece',
    )[0];
    expect(end.cursor).toBe(2);
    expect(end.printings).toBe(4);
    expect(end.done_at).not.toBeNull();
  });

  it('completes a small game in a single batch when the budget allows', async () => {
    const only = await runRefreshStep(env, { game: 'onepiece', batchSize: 50 });
    expect(only.done).toBe(true);
    expect(only.report).toMatchObject({ game: 'onepiece', sets: 2, printings: 4 });
  });
});

describe('admin/fingerprints-done', () => {
  let db: LocalD1;
  let env: Env;

  beforeEach(() => {
    db = new LocalD1();
    db.applyMigration(MIGRATION);
    env = {
      DB: db as unknown as D1Database,
      PACKS: new LocalR2() as unknown as R2Bucket,
      USER_AGENT: 'CardScan-test/0.1',
      SOURCE_MIN_INTERVAL_MS: '0',
      PUBLIC_BASE_URL: '',
      WORKER_ADMIN_TOKEN: 'secret',
    };
    // A game exists from the migration seed. Add a version, a card and a set,
    // then 150 printings — enough to cross the 90-id chunk boundary twice.
    db.prepare("INSERT INTO catalog_versions (game_id, version, created_at, printings_count) VALUES ('onepiece', '20260101', '2026-01-01', 150)").run();
    db.prepare("INSERT INTO sets (id, game_id, code, name) VALUES ('s1', 'onepiece', 'OP01', 'Set 1')").run();
    db.prepare("INSERT INTO cards (id, game_id, name, art_id) VALUES ('c1', 'onepiece', 'Card', 'a1')").run();
    for (let i = 0; i < 150; i += 1) {
      db.prepare(
        "INSERT INTO printings (id, card_id, game_id, set_id, number, updated_at) VALUES (?, ?, 'onepiece', 's1', ?, '2026-01-01')",
      )
        .bind(`p${i}`, 'c1', String(i))
        .run();
    }
  });

  it('marks every printing done across chunk boundaries and records the index key', async () => {
    const printingIds = Array.from({ length: 150 }, (_, i) => `p${i}`);
    const response = await app.fetch(
      new Request('https://cardscan-worker.workers.dev/admin/fingerprints-done', {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          game: 'onepiece',
          version: '20260101',
          printingIds,
          indexPackKey: 'games/onepiece/index-20260101.bin',
        }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    const done = db.query<{ n: number }>('SELECT COUNT(*) AS n FROM printings WHERE fingerprinted_at IS NOT NULL')[0];
    expect(done.n).toBe(150);
    const version = db.query<{ index_pack_key: string }>(
      "SELECT index_pack_key FROM catalog_versions WHERE game_id = 'onepiece'",
    )[0];
    expect(version.index_pack_key).toBe('games/onepiece/index-20260101.bin');
  });

  it('rejects an unauthorised call', async () => {
    const response = await app.fetch(
      new Request('https://cardscan-worker.workers.dev/admin/fingerprints-done', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ game: 'onepiece', version: '20260101', printingIds: [], indexPackKey: 'k' }),
      }),
      env,
    );
    expect(response.status).toBe(401);
  });
});
