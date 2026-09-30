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

  it('serves the latest available index for a newer version that has none of its own', async () => {
    stubFetch();
    await runRefresh(env, ['onepiece']);

    const first = await manifest();
    const oldVersion = first.games[0].version;
    // The fingerprint job attaches an index to this version.
    await db
      .prepare('UPDATE catalog_versions SET index_pack_key = ? WHERE game_id = ? AND version = ?')
      .bind(`games/onepiece/index-${oldVersion}.bin`, 'onepiece', oldVersion)
      .run();

    // A later nightly catalog refresh publishes a newer version that has no
    // index of its own yet (nothing new needed embedding, or it hasn't run).
    const newerVersion = '29991231';
    await db
      .prepare(
        'INSERT INTO catalog_versions (game_id, version, created_at, printings_count, index_pack_key) VALUES (?, ?, ?, ?, NULL)',
      )
      .bind('onepiece', newerVersion, new Date(Date.now() + 60_000).toISOString(), 5)
      .run();

    const body = await manifest();
    // The manifest serves the newest version, but with the older index — its
    // embeddings still cover every existing card — rather than no index at all.
    expect(body.games[0].version).toBe(newerVersion);
    expect(body.games[0].indexUrl).toMatch(new RegExp(`/packs/games/onepiece/index-${oldVersion}\\.bin$`));
    expect(body.games[0].indexIdsUrl).toMatch(new RegExp(`/packs/games/onepiece/index-${oldVersion}\\.ids$`));
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

  describe('listing printings for the fingerprint job', () => {
    async function list(query: string): Promise<Array<{ id: string }>> {
      const response = await app.fetch(
        new Request(`https://cardscan-worker.workers.dev/admin/pending-fingerprints?${query}`, {
          headers: { authorization: 'Bearer correct-token' },
        }),
        env,
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { printings: Array<{ id: string }> }).printings;
    }

    beforeEach(async () => {
      stubFetch();
      await runRefresh(env, ['onepiece']);
      env.WORKER_ADMIN_TOKEN = 'correct-token';
    });

    it('hides printings already marked fingerprinted by default', async () => {
      const everyone = await list('game=onepiece&all=1');
      // Mark two as done, as the job's callback does.
      await env.DB.prepare('UPDATE printings SET fingerprinted_at = ? WHERE id IN (?, ?)')
        .bind('2026-09-25T00:00:00Z', everyone[0].id, everyone[1].id)
        .run();

      const pending = await list('game=onepiece');
      expect(pending).toHaveLength(everyone.length - 2);
      expect(pending.map((p) => p.id)).not.toContain(everyone[0].id);
    });

    it('with all=1 lists every printing with an image, fingerprinted or not', async () => {
      const before = await list('game=onepiece&all=1');
      await env.DB.prepare('UPDATE printings SET fingerprinted_at = ? WHERE id = ?')
        .bind('2026-09-25T00:00:00Z', before[0].id)
        .run();

      const after = await list('game=onepiece&all=1');
      expect(after.map((p) => p.id)).toEqual(before.map((p) => p.id));
      expect(after).toHaveLength(4);
    });

    it('pages with offset in a stable order, without repeats or gaps', async () => {
      const all = await list('game=onepiece&all=1&limit=2000');
      const first = await list('game=onepiece&all=1&limit=3&offset=0');
      const second = await list('game=onepiece&all=1&limit=3&offset=3');

      expect(first).toHaveLength(3);
      expect([...first, ...second].map((p) => p.id)).toEqual(all.map((p) => p.id));
      expect(all.map((p) => p.id)).toEqual([...all.map((p) => p.id)].sort());
    });

    it('ignores offset unless asked for everything', async () => {
      const pending = await list('game=onepiece');
      const withOffset = await list('game=onepiece&offset=2');
      expect(withOffset).toHaveLength(pending.length);
    });
  });
});

describe('pack caching', () => {
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

  async function get(key: string): Promise<Response> {
    return app.fetch(new Request(`https://cardscan-worker.workers.dev/packs/${key}`), env);
  }

  it('serves an index pack revalidated, because the job rewrites it in place', async () => {
    await env.PACKS.put('games/onepiece/index-20260930.bin', new Uint8Array([1, 2, 3]));
    await env.PACKS.put('games/onepiece/index-20260930.ids', 'a\nb');

    for (const key of ['games/onepiece/index-20260930.bin', 'games/onepiece/index-20260930.ids']) {
      const response = await get(key);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('public, no-cache');
      expect(response.headers.get('etag')).toBeTruthy();
    }
  });

  it('answers HEAD with an ETag that changes when the pack is rewritten', async () => {
    const key = 'games/onepiece/index-20260930.bin';
    const head = () =>
      app.fetch(new Request(`https://cardscan-worker.workers.dev/packs/${key}`, { method: 'HEAD' }), env);

    await env.PACKS.put(key, new Uint8Array([1, 2, 3]));
    const first = await head();
    expect(first.status).toBe(200);
    const firstTag = first.headers.get('etag');
    expect(firstTag).toBeTruthy();

    // The job grows the pack in place: same URL, new content.
    await env.PACKS.put(key, new Uint8Array([1, 2, 3, 4, 5, 6]));
    const second = await head();
    expect(second.headers.get('etag')).toBeTruthy();
    expect(second.headers.get('etag')).not.toBe(firstTag);
  });

  it('still serves catalog and delta packs as immutable', async () => {
    await env.PACKS.put('games/onepiece/catalog-20260930.json', '{}');
    await env.PACKS.put('games/onepiece/delta-20260929-20260930.json', '{}');

    for (const key of ['games/onepiece/catalog-20260930.json', 'games/onepiece/delta-20260929-20260930.json']) {
      const response = await get(key);
      expect(response.headers.get('cache-control')).toContain('immutable');
    }
  });
});
