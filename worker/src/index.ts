/**
 * CardScan Worker.
 *
 * Serves the manifest and packs the app downloads, and runs the daily refresh
 * on a cron trigger. Scanning itself never touches this Worker — it happens on
 * the phone — so this stays small and cheap.
 */
import { Hono } from 'hono';
import { buildDelta, buildFullDelta, importGame, nextVersion, publishPack } from './catalog';
import { Env, GameId, Manifest } from './types';

const GAMES: GameId[] = ['onepiece', 'pokemon', 'mtg', 'yugioh', 'lorcana'];

// One Piece and Pokémon first — James's priority games.
const REFRESH_ORDER: GameId[] = ['onepiece', 'pokemon', 'mtg', 'yugioh', 'lorcana'];

const app = new Hono<{ Bindings: Env }>();

/**
 * Absolute URL for a pack. PUBLIC_BASE_URL wins when set (a custom domain), and
 * otherwise the origin of the request is used -- so a fresh deploy serves a
 * usable manifest without anyone having to set a variable first.
 */
function packUrl(origin: string, env: Env, key: string): string {
  const base = (env.PUBLIC_BASE_URL || origin).replace(/\/$/, '');
  return `${base}/packs/${key}`;
}

app.get('/health', (c) => c.json({ ok: true }));

/** What the app reads on every sync. */
app.get('/manifest.json', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT game_id AS gameId, version, printings_count AS printingsCount, index_pack_key AS indexPackKey, created_at AS createdAt
     FROM catalog_versions ORDER BY created_at DESC`,
  ).all();

  const byGame = new Map<string, any>();
  const history = new Map<string, string[]>();

  for (const row of rows.results as any[]) {
    if (!byGame.has(row.gameId)) byGame.set(row.gameId, row);
    const versions = history.get(row.gameId) ?? [];
    versions.push(row.version);
    history.set(row.gameId, versions);
  }

  const origin = new URL(c.req.url).origin;
  const manifest: Manifest = {
    version: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    games: [...byGame.values()].map((row) => {
      // Deltas are published between consecutive versions, newest first.
      const versions = history.get(row.gameId) ?? [];
      const deltas = versions.slice(1, 15).map((from, index) => ({
        from,
        to: versions[index],
        url: packUrl(origin, c.env, `games/${row.gameId}/delta-${from}-${versions[index]}.json`),
      }));

      return {
        game: row.gameId as GameId,
        version: row.version,
        printingsCount: row.printingsCount,
        catalogUrl: packUrl(origin, c.env, `games/${row.gameId}/catalog-${row.version}.json`),
        indexUrl: packUrl(origin, c.env, `games/${row.gameId}/index-${row.version}.bin`),
        indexIdsUrl: packUrl(origin, c.env, `games/${row.gameId}/index-${row.version}.ids`),
        deltas,
      };
    }),
  };

  return c.json(manifest, 200, { 'Cache-Control': 'public, max-age=900' });
});

/** Packs and index files live in R2 and are immutable once published. */
app.get('/packs/*', async (c) => {
  const key = c.req.path.replace(/^\/packs\//, '');
  const object = await c.env.PACKS.get(key);
  if (!object) return c.notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(object.body, { headers });
});

app.get('/card/:id', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT p.id, c.name, s.code AS setCode, s.name AS setName, p.number, p.set_total AS setTotal,
            p.rarity, p.variant, p.language, p.image_url AS imageUrl
     FROM printings p JOIN cards c ON c.id = p.card_id JOIN sets s ON s.id = p.set_id
     WHERE p.id = ?`,
  )
    .bind(c.req.param('id'))
    .first();

  if (!row) return c.notFound();

  const prices = await c.env.DB.prepare(
    'SELECT source, currency, market, low, trend, avg7, avg30, as_of AS asOf FROM prices_latest WHERE printing_id = ?',
  )
    .bind(c.req.param('id'))
    .all();

  return c.json({ ...row, prices: prices.results });
});

app.get('/search', async (c) => {
  const query = c.req.query('q')?.trim();
  if (!query) return c.json({ results: [] });

  const rows = await c.env.DB.prepare(
    `SELECT p.id, c.name, s.code AS setCode, p.number, p.variant
     FROM printings p JOIN cards c ON c.id = p.card_id JOIN sets s ON s.id = p.set_id
     WHERE c.name LIKE ? LIMIT 50`,
  )
    .bind(`%${query}%`)
    .all();

  return c.json({ results: rows.results });
});

/** Printings still waiting for a fingerprint — polled by the GitHub Action. */
app.get('/admin/pending-fingerprints', async (c) => {
  if (!authorised(c.req.header('authorization'), c.env)) return c.text('Unauthorized', 401);

  const game = c.req.query('game');
  const limit = Math.min(Number(c.req.query('limit') ?? 500), 2000);
  const rows = await c.env.DB.prepare(
    `SELECT id, game_id AS gameId, image_url AS imageUrl
     FROM printings
     WHERE fingerprinted_at IS NULL AND image_url IS NOT NULL ${game ? 'AND game_id = ?' : ''}
     LIMIT ?`,
  )
    .bind(...(game ? [game, limit] : [limit]))
    .all();

  return c.json({ printings: rows.results });
});

/** Called by the fingerprint job once an index pack has been uploaded. */
app.post('/admin/fingerprints-done', async (c) => {
  if (!authorised(c.req.header('authorization'), c.env)) return c.text('Unauthorized', 401);

  const body = (await c.req.json()) as { game: GameId; version: string; printingIds: string[]; indexPackKey: string };
  const now = new Date().toISOString();

  const chunks: string[][] = [];
  for (let i = 0; i < body.printingIds.length; i += 100) chunks.push(body.printingIds.slice(i, i + 100));

  for (const chunk of chunks) {
    await c.env.DB.prepare(
      `UPDATE printings SET fingerprinted_at = ? WHERE id IN (${chunk.map(() => '?').join(',')})`,
    )
      .bind(now, ...chunk)
      .run();
  }

  await c.env.DB.prepare('UPDATE catalog_versions SET index_pack_key = ? WHERE game_id = ? AND version = ?')
    .bind(body.indexPackKey, body.game, body.version)
    .run();

  return c.json({ ok: true, updated: body.printingIds.length });
});

/** Manual trigger, same work the cron does. */
app.post('/admin/refresh', async (c) => {
  if (!authorised(c.req.header('authorization'), c.env)) return c.text('Unauthorized', 401);
  const game = c.req.query('game') as GameId | undefined;
  const report = await runRefresh(c.env, game ? [game] : REFRESH_ORDER);
  return c.json(report);
});

function authorised(header: string | undefined, env: Env): boolean {
  if (!env.WORKER_ADMIN_TOKEN) return false;
  return header === `Bearer ${env.WORKER_ADMIN_TOKEN}`;
}

/**
 * The daily job: pull catalogs and prices, then publish a full catalog pack and
 * a delta from the previous version.
 */
export async function runRefresh(env: Env, games: GameId[]): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  const run = await env.DB.prepare('INSERT INTO refresh_runs (started_at, status) VALUES (?, ?) RETURNING id')
    .bind(startedAt, 'running')
    .first<{ id: number }>();

  const reports: Record<string, unknown> = {};
  const options = {
    userAgent: env.USER_AGENT,
    minIntervalMs: Number(env.SOURCE_MIN_INTERVAL_MS ?? 1000),
  };

  try {
    for (const game of games) {
      const previous = await env.DB.prepare(
        'SELECT version, created_at AS createdAt FROM catalog_versions WHERE game_id = ? ORDER BY created_at DESC LIMIT 1',
      )
        .bind(game)
        .first<{ version: string; createdAt: string }>();

      const report = await importGame(env, game, options);
      const version = nextVersion();

      await publishPack(env, `games/${game}/catalog-${version}.json`, await buildFullDelta(env, game, version));

      if (previous) {
        await publishPack(
          env,
          `games/${game}/delta-${previous.version}-${version}.json`,
          await buildDelta(env, game, previous.version, version, previous.createdAt),
        );
      }

      await env.DB.prepare(
        `INSERT INTO catalog_versions (game_id, version, created_at, printings_count)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (game_id, version) DO UPDATE SET printings_count = excluded.printings_count`,
      )
        .bind(game, version, new Date().toISOString(), report.printings)
        .run();

      reports[game] = report;
    }

    await env.DB.prepare('UPDATE refresh_runs SET finished_at = ?, status = ?, detail = ? WHERE id = ?')
      .bind(new Date().toISOString(), 'ok', JSON.stringify(reports), run?.id ?? 0)
      .run();
  } catch (error) {
    // A failed refresh leaves the last good version in place; the app keeps
    // using what it already has.
    await env.DB.prepare('UPDATE refresh_runs SET finished_at = ?, status = ?, detail = ? WHERE id = ?')
      .bind(new Date().toISOString(), 'failed', String(error), run?.id ?? 0)
      .run();
    throw error;
  }

  return reports;
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runRefresh(env, REFRESH_ORDER));
  },
};

export { GAMES, app };
