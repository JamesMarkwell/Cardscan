/**
 * CardScan Worker.
 *
 * Serves the manifest and packs the app downloads, and runs the daily refresh
 * on a cron trigger. Scanning itself never touches this Worker — it happens on
 * the phone — so this stays small and cheap.
 */
import { Hono } from 'hono';
import { buildDelta, buildFullDelta, importGame, importGameBatch, nextVersion, publishPack } from './catalog';
import { Env, GameId, Manifest } from './types';

const GAMES: GameId[] = ['onepiece', 'pokemon', 'mtg', 'yugioh', 'lorcana'];

// One Piece and Pokémon first — James's priority games.
const REFRESH_ORDER: GameId[] = ['onepiece', 'pokemon', 'mtg', 'yugioh', 'lorcana'];

// How many sets to import per Worker invocation. Each set costs two outbound
// requests (products + prices) plus one for the set list, so 12 keeps a batch
// at ~25 requests — comfortably under Cloudflare's 50-per-invocation free-plan
// limit, with room for the rate-limit sleeps to stay inside the wall-clock cap.
const BATCH_SETS = 12;

// A built game is refreshed again once its newest pack is older than this. The
// cron keeps existing games current; it does not start importing a game that
// has never been built (that is done deliberately via /admin/refresh?game=).
const REFRESH_STALE_MS = 20 * 60 * 60 * 1000;

interface ImportProgress {
  game_id: GameId;
  run_id: number | null;
  cursor: number;
  total: number;
  sets: number;
  printings: number;
  prices: number;
  unmatched: number;
  started_at: string | null;
  updated_at: string | null;
  done_at: string | null;
}

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

/**
 * Manual trigger. Runs one batch of the import and reports whether more remain,
 * so the caller loops until `done` is true (see .github/workflows/deploy-worker.yml).
 * Each call is a fresh Worker invocation with its own subrequest budget.
 *
 * ?game=  imports that game, starting a fresh pass if the last one finished.
 *         Omitted, it advances whichever built game is next due (what the cron does).
 * ?batch= overrides how many sets to import in this call (default BATCH_SETS).
 */
app.post('/admin/refresh', async (c) => {
  if (!authorised(c.req.header('authorization'), c.env)) return c.text('Unauthorized', 401);
  const game = c.req.query('game') as GameId | undefined;
  const batchParam = Number(c.req.query('batch'));
  const batchSize = Number.isFinite(batchParam) && batchParam > 0 ? batchParam : BATCH_SETS;
  try {
    const report = await runRefreshStep(c.env, { game, batchSize });
    return c.json(report);
  } catch (error) {
    return c.json({ ok: false, error: String(error) }, 500);
  }
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
      await publishGame(env, game, report.printings, previous);
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

type PreviousVersion = { version: string; createdAt: string };

/** Publish a game's full catalog pack (and a delta from the previous version) and record the new version. */
async function publishGame(
  env: Env,
  game: GameId,
  printingsCount: number,
  previous?: PreviousVersion | null,
): Promise<string> {
  const prior =
    previous === undefined
      ? await env.DB.prepare(
          'SELECT version, created_at AS createdAt FROM catalog_versions WHERE game_id = ? ORDER BY created_at DESC LIMIT 1',
        )
          .bind(game)
          .first<PreviousVersion>()
      : previous;

  const version = nextVersion();
  await publishPack(env, `games/${game}/catalog-${version}.json`, await buildFullDelta(env, game, version));

  if (prior && prior.version !== version) {
    await publishPack(
      env,
      `games/${game}/delta-${prior.version}-${version}.json`,
      await buildDelta(env, game, prior.version, version, prior.createdAt),
    );
  }

  await env.DB.prepare(
    `INSERT INTO catalog_versions (game_id, version, created_at, printings_count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (game_id, version) DO UPDATE SET printings_count = excluded.printings_count`,
  )
    .bind(game, version, new Date().toISOString(), printingsCount)
    .run();

  return version;
}

async function loadProgress(env: Env, game: GameId): Promise<ImportProgress | null> {
  return env.DB.prepare('SELECT * FROM import_progress WHERE game_id = ?').bind(game).first<ImportProgress>();
}

/**
 * The next game the cron should work on: any import still in progress first,
 * then a built game whose newest pack has gone stale. A game that has never
 * been built is left alone — it is onboarded deliberately, not by the cron.
 */
async function pickDueGame(env: Env): Promise<GameId | null> {
  const inProgress = await env.DB.prepare(
    'SELECT game_id FROM import_progress WHERE done_at IS NULL ORDER BY updated_at LIMIT 1',
  ).first<{ game_id: GameId }>();
  if (inProgress) return inProgress.game_id;

  const cutoff = new Date(Date.now() - REFRESH_STALE_MS).toISOString();
  const stale = await env.DB.prepare(
    `SELECT game_id, MAX(created_at) AS latest FROM catalog_versions
     GROUP BY game_id HAVING latest < ? ORDER BY latest LIMIT 1`,
  )
    .bind(cutoff)
    .first<{ game_id: GameId }>();
  return stale?.game_id ?? null;
}

/**
 * Import one batch of sets for a single game, resuming from where the last
 * invocation left off, and publish the packs once the final batch lands. This
 * is the unit of work small enough to fit a Worker's subrequest budget; the
 * caller repeats it until the response says `done`.
 */
export async function runRefreshStep(
  env: Env,
  opts: { game?: GameId; batchSize?: number } = {},
): Promise<Record<string, unknown>> {
  const batchSize = opts.batchSize ?? BATCH_SETS;
  const options = {
    userAgent: env.USER_AGENT,
    minIntervalMs: Number(env.SOURCE_MIN_INTERVAL_MS ?? 1000),
  };
  const stamp = () => new Date().toISOString();

  let game = opts.game;
  let progress = game ? await loadProgress(env, game) : null;
  if (!game) {
    const due = await pickDueGame(env);
    if (!due) return { done: true, idle: true };
    game = due;
    progress = await loadProgress(env, game);
  }

  // No active pass (never started, or the previous one finished) → begin a
  // fresh run and reset the cursor.
  if (!progress || progress.done_at) {
    const run = await env.DB.prepare('INSERT INTO refresh_runs (started_at, status) VALUES (?, ?) RETURNING id')
      .bind(stamp(), 'running')
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO import_progress (game_id, run_id, cursor, total, sets, printings, prices, unmatched, started_at, updated_at, done_at)
       VALUES (?, ?, 0, 0, 0, 0, 0, 0, ?, ?, NULL)
       ON CONFLICT (game_id) DO UPDATE SET run_id = excluded.run_id, cursor = 0, total = 0,
         sets = 0, printings = 0, prices = 0, unmatched = 0,
         started_at = excluded.started_at, updated_at = excluded.updated_at, done_at = NULL`,
    )
      .bind(game, run?.id ?? null, stamp(), stamp())
      .run();
    progress = (await loadProgress(env, game))!;
  }

  const p = progress;
  try {
    const { report, total, nextCursor } = await importGameBatch(env, game, options, p.cursor, batchSize);
    const totals = {
      sets: p.sets + report.sets,
      printings: p.printings + report.printings,
      prices: p.prices + report.prices,
      unmatched: p.unmatched + report.unmatched,
    };
    const done = nextCursor >= total;

    if (done) {
      const version = await publishGame(env, game, totals.printings);
      await env.DB.prepare(
        `UPDATE import_progress SET cursor = ?, total = ?, sets = ?, printings = ?, prices = ?,
           unmatched = ?, updated_at = ?, done_at = ? WHERE game_id = ?`,
      )
        .bind(nextCursor, total, totals.sets, totals.printings, totals.prices, totals.unmatched, stamp(), stamp(), game)
        .run();
      const finalReport = { game, ...totals };
      if (p.run_id) {
        await env.DB.prepare('UPDATE refresh_runs SET finished_at = ?, status = ?, detail = ? WHERE id = ?')
          .bind(stamp(), 'ok', JSON.stringify(finalReport), p.run_id)
          .run();
      }
      return { game, done: true, cursor: nextCursor, total, version, report: finalReport };
    }

    await env.DB.prepare(
      `UPDATE import_progress SET cursor = ?, total = ?, sets = ?, printings = ?, prices = ?,
         unmatched = ?, updated_at = ? WHERE game_id = ?`,
    )
      .bind(nextCursor, total, totals.sets, totals.printings, totals.prices, totals.unmatched, stamp(), game)
      .run();
    return { game, done: false, cursor: nextCursor, total, report: { game, ...totals } };
  } catch (error) {
    // Leave the cursor where it is so the next call resumes; record the failure
    // against the run. The previous good version stays live for the app.
    if (p.run_id) {
      await env.DB.prepare('UPDATE refresh_runs SET finished_at = ?, status = ?, detail = ? WHERE id = ?')
        .bind(stamp(), 'failed', String(error), p.run_id)
        .run();
    }
    await env.DB.prepare('UPDATE import_progress SET updated_at = ? WHERE game_id = ?').bind(stamp(), game).run();
    throw error;
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // One batch per tick: enough sets to stay under the subrequest limit, and
    // the frequent schedule (see wrangler.toml) works through a game over
    // successive ticks. Failures are recorded; the next tick resumes.
    ctx.waitUntil(runRefreshStep(env).catch(() => undefined));
  },
};

export { GAMES, app };
