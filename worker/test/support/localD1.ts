/**
 * A D1 stand-in backed by node:sqlite, plus an in-memory R2 bucket.
 *
 * D1 is SQLite, so running the real import against a real SQLite database
 * exercises the actual SQL -- the upserts, the INSERT..SELECT..ON CONFLICT, the
 * foreign keys -- rather than a mock that agrees with whatever we wrote.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// node:sqlite is still flagged experimental, so it is absent from
// module.builtinModules and Vite tries to resolve it as a package. Loading it
// through createRequire keeps it out of the static dependency graph.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

type DatabaseSync = InstanceType<typeof DatabaseSync>;

type Row = Record<string, unknown>;

function normalise(value: unknown): unknown {
  // node:sqlite rejects booleans and undefined; D1 accepts both.
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

class LocalStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): LocalStatement {
    return new LocalStatement(this.db, this.sql, values.map(normalise));
  }

  private statement() {
    return this.db.prepare(this.sql);
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const result = this.statement().run(...(this.params as never[]));
    return {
      success: true,
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    };
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.statement().get(...(this.params as never[])) as Row | undefined;
    if (!row) return null;
    return (column ? (row[column] as T) : (row as unknown as T)) ?? null;
  }

  async all<T = Row>(): Promise<{ success: true; results: T[] }> {
    const rows = this.statement().all(...(this.params as never[])) as unknown as T[];
    return { success: true, results: rows };
  }
}

export class LocalD1 {
  readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(':memory:');
    // D1 enforces foreign keys, so a broken reference should fail here too.
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  applyMigration(path: string): void {
    this.db.exec(readFileSync(path, 'utf8'));
  }

  prepare(sql: string): LocalStatement {
    return new LocalStatement(this.db, sql);
  }

  async batch<T = Row>(statements: LocalStatement[]): Promise<Array<{ success: true; results: T[] }>> {
    this.db.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) {
        await statement.run();
        results.push({ success: true as const, results: [] as T[] });
      }
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }

  /** Convenience for assertions. */
  query<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params.map(normalise) as never[])) as unknown as T[];
  }

  count(table: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return Number(row.n);
  }
}

interface StoredObject {
  body: string;
  httpMetadata?: { contentType?: string; cacheControl?: string };
}

/**
 * In-memory R2. Implements the parts of R2Object the Worker actually touches --
 * body, writeHttpMetadata and httpEtag -- so the pack-serving route runs for
 * real rather than against a stub that cannot fail.
 */
export class LocalR2 {
  readonly objects = new Map<string, StoredObject>();

  async put(key: string, body: string, options?: StoredObject['httpMetadata'] extends undefined ? never : { httpMetadata?: StoredObject['httpMetadata'] }): Promise<void> {
    this.objects.set(key, { body, httpMetadata: options?.httpMetadata });
  }

  async get(key: string) {
    const stored = this.objects.get(key);
    if (stored === undefined) return null;

    return {
      key,
      body: new Blob([stored.body]).stream(),
      httpEtag: `"${key.length}-${stored.body.length}"`,
      size: stored.body.length,
      writeHttpMetadata(headers: Headers) {
        if (stored.httpMetadata?.contentType) headers.set('content-type', stored.httpMetadata.contentType);
        if (stored.httpMetadata?.cacheControl) headers.set('cache-control', stored.httpMetadata.cacheControl);
      },
      text: async () => stored.body,
    };
  }

  json<T>(key: string): T {
    const stored = this.objects.get(key);
    if (stored === undefined) throw new Error(`No R2 object at ${key}`);
    return JSON.parse(stored.body) as T;
  }
}
