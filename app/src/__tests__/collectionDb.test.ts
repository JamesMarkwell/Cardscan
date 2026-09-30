/**
 * The collection's edit/remove/search queries, against a mocked connection: what
 * matters here is the SQL they issue and the merge rule when an edit would make
 * two rows identical.
 */
import { closeDatabase, openDatabase, removeFromCollection, removeManyFromCollection, removeOneFromCollection, ownedQuantity, searchPrintings, updateCollectionEntry } from '../data/db';

const db = {
  execAsync: jest.fn().mockResolvedValue(undefined),
  getFirstAsync: jest.fn(),
  getAllAsync: jest.fn().mockResolvedValue([]),
  runAsync: jest.fn().mockResolvedValue(undefined),
  closeAsync: jest.fn().mockResolvedValue(undefined),
  withTransactionAsync: jest.fn(async (work: () => Promise<void>) => work()),
};

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn(async () => db) }));

const ROW = { portfolio_id: 1, printing_id: 'p1', variant: 'normal', condition: 'NM', quantity: 2 };

// Open (and migrate) once up front, so the migration's own queries don't consume
// the answers each test queues for the function under test.
beforeAll(async () => {
  db.getFirstAsync.mockResolvedValue({ count: 1 });
  await openDatabase();
});

beforeEach(() => {
  db.getFirstAsync.mockReset();
  db.getAllAsync.mockReset().mockResolvedValue([]);
  db.runAsync.mockClear();
});

afterAll(async () => {
  await closeDatabase();
});

/** Queries the function issued after opening (the migration also uses these mocks). */
const sqlIssued = () => db.runAsync.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim());

describe('updateCollectionEntry', () => {
  it('updates the row in place when nothing else has the same variant and condition', async () => {
    db.getFirstAsync.mockResolvedValueOnce(ROW).mockResolvedValueOnce(null);

    await updateCollectionEntry(7, { quantity: 5 });

    const update = db.runAsync.mock.calls.find(([sql]) => String(sql).includes('UPDATE collection SET variant'));
    expect(update?.[1]).toEqual(['normal', 'NM', 5, 7]);
  });

  it('never lets the quantity fall below one', async () => {
    db.getFirstAsync.mockResolvedValueOnce(ROW).mockResolvedValueOnce(null);
    await updateCollectionEntry(7, { quantity: 0 });
    const update = db.runAsync.mock.calls.find(([sql]) => String(sql).includes('UPDATE collection SET variant'));
    expect(update?.[1]?.[2]).toBe(1);
  });

  it('merges into an existing row when the new condition already exists', async () => {
    db.getFirstAsync.mockResolvedValueOnce(ROW).mockResolvedValueOnce({ id: 9 });

    await updateCollectionEntry(7, { condition: 'LP' });

    const sql = sqlIssued();
    expect(sql.some((s) => s.startsWith('UPDATE collection SET quantity = quantity + ?'))).toBe(true);
    expect(db.runAsync.mock.calls.find(([s]) => String(s).includes('quantity = quantity + ?'))?.[1]).toEqual([2, 9]);
    expect(sql.some((s) => s.startsWith('DELETE FROM collection WHERE id = ?'))).toBe(true);
  });

  it('does nothing for a row that no longer exists', async () => {
    db.getFirstAsync.mockResolvedValueOnce(null);
    await updateCollectionEntry(7, { quantity: 3 });
    expect(sqlIssued().filter((s) => s.startsWith('UPDATE collection') || s.startsWith('DELETE FROM collection'))).toEqual([]);
  });
});

it('removeFromCollection deletes just that row', async () => {
  await removeFromCollection(4);
  const call = db.runAsync.mock.calls.find(([sql]) => String(sql).startsWith('DELETE FROM collection'));
  expect(call?.[1]).toEqual([4]);
});

describe('undoing an automatic add', () => {
  it('takes one copy off a stack, and removes a single copy, for that exact card only', async () => {
    await removeOneFromCollection(1, 'p1', 'foil', 'NM');
    const sql = db.runAsync.mock.calls.map(([q]) => String(q).replace(/\s+/g, ' '));
    expect(sql.some((q) => q.startsWith('UPDATE collection SET quantity = quantity - 1') && q.includes('AND quantity > 1'))).toBe(true);
    expect(sql.some((q) => q.startsWith('DELETE FROM collection') && q.includes('AND quantity <= 1'))).toBe(true);
    for (const [, args] of db.runAsync.mock.calls) expect(args).toEqual([1, 'p1', 'foil', 'NM']);
  });

  it('reports how many of a card are owned, zero when none', async () => {
    db.getFirstAsync.mockResolvedValueOnce({ quantity: 3 });
    expect(await ownedQuantity(1, 'p1', 'normal', 'NM')).toBe(3);
    db.getFirstAsync.mockResolvedValueOnce(null);
    expect(await ownedQuantity(1, 'p2', 'normal', 'NM')).toBe(0);
  });
});

describe('removeManyFromCollection', () => {
  it('deletes every given row in one statement', async () => {
    await removeManyFromCollection([3, 5, 8]);
    const call = db.runAsync.mock.calls.find(([sql]) => String(sql).includes('DELETE FROM collection WHERE id IN'));
    expect(String(call?.[0])).toContain('IN (?,?,?)');
    expect(call?.[1]).toEqual([3, 5, 8]);
  });

  it('batches a very large selection', async () => {
    await removeManyFromCollection(Array.from({ length: 1200 }, (_, i) => i + 1));
    const deletes = db.runAsync.mock.calls.filter(([sql]) => String(sql).includes('DELETE FROM collection WHERE id IN'));
    expect(deletes.map(([, args]) => args.length)).toEqual([500, 500, 200]);
  });

  it('does nothing for an empty selection', async () => {
    await removeManyFromCollection([]);
    expect(db.runAsync).not.toHaveBeenCalled();
  });
});

describe('searchPrintings', () => {
  it('returns nothing, without touching the database, for a blank query', async () => {
    expect(await searchPrintings({ query: '   ' })).toEqual([]);
    expect(db.getAllAsync).not.toHaveBeenCalled();
  });

  it('requires every word to match, scoped to a game, and pages', async () => {
    await searchPrintings({ query: 'charizard base', gameId: 'pokemon', limit: 10, offset: 20 });

    const [sql, args] = db.getAllAsync.mock.calls[0];
    expect(String(sql)).toContain('p.game_id = ?');
    expect(String(sql).match(/c\.name LIKE \? OR p\.number LIKE \?/g)).toHaveLength(2);
    // game, four patterns per word, the prefix used for ordering, then limit and offset
    expect(args).toEqual([
      'pokemon',
      '%charizard%', '%charizard%', '%charizard%', '%charizard%',
      '%base%', '%base%', '%base%', '%base%',
      'charizard%',
      10,
      20,
    ]);
  });

  it('falls back to TCGplayer prices when there is no Cardmarket price', async () => {
    await searchPrintings({ query: 'pika' });
    const sql = String(db.getAllAsync.mock.calls[0][0]);
    expect(sql).toContain("pc.source = 'cardmarket'");
    expect(sql).toContain("pt.source = 'tcgplayer'");
    // Cardmarket's price wins when present, otherwise TCGplayer's, each with its own currency.
    expect(sql).toMatch(/THEN COALESCE\(pc\.market, pc\.trend, pc\.low\)\s+ELSE COALESCE\(pt\.market, pt\.low\) END AS market/);
    expect(sql).toMatch(/THEN pc\.currency ELSE pt\.currency END AS price_currency/);
  });

  it('maps rows to printings with their picture and price', async () => {
    db.getAllAsync.mockResolvedValueOnce([
      {
        id: 'p1', card_id: 'c1', game_id: 'pokemon', name: 'Pikachu', set_id: 's1', set_code: 'BS',
        set_name: 'Base Set', number: '58', set_total: '102', rarity: 'Common', variant: 'normal',
        language: 'en', image_key: null, image_url: 'https://img/p1.jpg', tcgplayer_product_id: 1,
        cardmarket_product_id: null, market: 4.5, price_currency: 'GBP',
      },
    ]);

    const [result] = await searchPrintings({ query: 'pika' });

    expect(result).toMatchObject({ id: 'p1', name: 'Pikachu', imageUrl: 'https://img/p1.jpg', market: 4.5, currency: 'GBP' });
  });
});
