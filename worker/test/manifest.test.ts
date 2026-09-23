/**
 * The manifest is the contract between the Worker and the phone: the app reads
 * it on every sync and follows the URLs in it. These tests pin the shape and
 * check the URLs actually resolve to published packs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from '../src/index';
import { runRefresh } from '../src/index';
import { Env, Manifest } from '../src/types';
import { LocalD1, LocalR2 } from './support/localD1';

const MIGRATION = join(__dirname, '..', 'migrations', '0001_init.sql');
const FIXTURES = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'tcgcsv-onepiece.json'), 'utf8'),
) as { groups: unknown; products: Record<string, unknown>; prices: Record<string, unknown> };

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      const products = path.match(/^\/tcgplayer\/\d+\/(\d+)\/products$/);
      const prices = path.match(/^\/tcgplayer\/\d+\/(\d+)\/prices$/);
      const body = /\/groups$/.test(path)
        ? FIXTURES.groups
        : products
          ? FIXTURES.products[products[1]]
          : prices
            ? FIXTURES.prices[prices[1]]
            : null;
      if (!body) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

describe('manifest', () => {
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
      PUBLIC_BASE_URL: '',
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function manifest(origin = 'https://cardscan-worker.workers.dev'): Promise<Manifest> {
    const response = await app.fetch(new Request(`${origin}/manifest.json`), env);
    expect(response.status).toBe(200);
    return (await response.json()) as Manifest;
  }

  it('is empty but valid before anything has been published', async () => {
    const body = await manifest();
    expect(body.games).toEqual([]);
    expect(body.generatedAt).toBeTruthy();
  });

  it('falls back to the request origin when PUBLIC_BASE_URL is unset', async () => {
    stubFetch();
    await runRefresh(env, ['onepiece']);

    const body = await manifest('https://cardscan-worker.workers.dev');
    expect(body.games).toHaveLength(1);
    expect(body.games[0].catalogUrl).toMatch(/^https:\/\/cardscan-worker\.workers\.dev\/packs\//);
  });

  it('prefers PUBLIC_BASE_URL when one is configured', async () => {
    stubFetch();
    await runRefresh(env, ['onepiece']);
    env.PUBLIC_BASE_URL = 'https://cards.example.com/';

    const body = await manifest();
    expect(body.games[0].catalogUrl).toMatch(/^https:\/\/cards\.example\.com\/packs\//);
    expect(body.games[0].catalogUrl).not.toContain('//packs');
  });

  it('omits the index URLs until a fingerprint pack has been published', async () => {
    stubFetch();
    await runRefresh(env, ['onepiece']);

    const before = await manifest();
    expect(before.games[0].indexUrl).toBeUndefined();
    expect(before.games[0].indexIdsUrl).toBeUndefined();

    // The fingerprint job records the published index key.
    const version = before.games[0].version;
    await db
      .prepare('UPDATE catalog_versions SET index_pack_key = ? WHERE game_id = ? AND version = ?')
      .bind(`games/onepiece/index-${version}.bin`, 'onepiece', version)
      .run();

    const after = await manifest();
    expect(after.games[0].indexUrl).toMatch(new RegExp(`/packs/games/onepiece/index-${version}\\.bin$`));
    expect(after.games[0].indexIdsUrl).toMatch(new RegExp(`/packs/games/onepiece/index-${version}\\.ids$`));
  });

  it('points at a catalog pack that is actually there', async () => {
    stubFetch();
    await runRefresh(env, ['onepiece']);

    const body = await manifest();
    const game = body.games[0];
    expect(game.game).toBe('onepiece');
    expect(game.printingsCount).toBe(4);

    const path = new URL(game.catalogUrl).pathname;
    const response = await app.fetch(new Request(`https://cardscan-worker.workers.dev${path}`), env);
    expect(response.status).toBe(200);

    const pack = (await response.json()) as { printings: unknown[] };
    expect(pack.printings).toHaveLength(4);
  });

  it('404s for a pack that was never published', async () => {
    const response = await app.fetch(
      new Request('https://cardscan-worker.workers.dev/packs/games/onepiece/nope.json'),
      env,
    );
    expect(response.status).toBe(404);
  });

  it('refuses admin routes without the token', async () => {
    const response = await app.fetch(
      new Request('https://cardscan-worker.workers.dev/admin/pending-fingerprints'),
      env,
    );
    expect(response.status).toBe(401);
  });

  it('refuses admin routes with the wrong token', async () => {
    env.WORKER_ADMIN_TOKEN = 'correct-token';
    const response = await app.fetch(
      new Request('https://cardscan-worker.workers.dev/admin/pending-fingerprints', {
        headers: { authorization: 'Bearer wrong-token' },
      }),
      env,
    );
    expect(response.status).toBe(401);
  });

  it('lists printings needing a fingerprint for the fingerprint job', async () => {
    stubFetch();
    await runRefresh(env, ['onepiece']);
    env.WORKER_ADMIN_TOKEN = 'correct-token';

    const response = await app.fetch(
      new Request('https://cardscan-worker.workers.dev/admin/pending-fingerprints?game=onepiece', {
        headers: { authorization: 'Bearer correct-token' },
      }),
      env,
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as { printings: Array<{ id: string; imageUrl: string }> };
    expect(body.printings).toHaveLength(4);
    expect(body.printings[0].imageUrl).toMatch(/^https:\/\//);
  });
});
