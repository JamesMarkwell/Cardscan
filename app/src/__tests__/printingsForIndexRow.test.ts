/**
 * The scan index is keyed by printing id, not art id.
 *
 * A search hit is an index row whose id is a printing id (the fingerprint job
 * writes the printing it embedded). Looking that id up as an art id found no
 * printings, so a genuine match came back as "No match". These tests pin the
 * lookup: resolve the printing's artwork, then every printing sharing it, with
 * the matched printing first.
 */
import { closeDatabase, printingsForIndexRow } from '../data/db';

const getFirstAsync = jest.fn();
const getAllAsync = jest.fn();

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn().mockImplementation(async () => ({
    execAsync: jest.fn().mockResolvedValue(undefined),
    getFirstAsync: (...args: unknown[]) => getFirstAsync(...args),
    getAllAsync: (...args: unknown[]) => getAllAsync(...args),
    runAsync: jest.fn().mockResolvedValue(undefined),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  })),
}));

function row(id: string, variant: string) {
  return {
    id,
    card_id: 'pokemon:umbreon',
    game_id: 'pokemon',
    name: 'Umbreon',
    set_id: 'pokemon:30c',
    set_code: '30C',
    set_name: '30th Celebration',
    number: '091',
    set_total: 128,
    rarity: 'Rare',
    variant,
    language: 'en',
    image_key: null,
    tcgplayer_product_id: null,
    cardmarket_product_id: null,
  };
}

beforeEach(() => {
  getFirstAsync.mockReset();
  getAllAsync.mockReset();
  // openDatabase()'s own migration probes the connection; give it a benign answer
  // first, then the real lookup result set per test.
  getFirstAsync.mockResolvedValue({ count: 1 });
});

afterEach(async () => {
  await closeDatabase();
});

it('resolves a printing id to the printings that share its artwork', async () => {
  getFirstAsync.mockResolvedValue({ art_id: 'pokemon:umbreon:30c-091-umbreon' });
  getAllAsync.mockResolvedValue([row('pokemon:30c:091:normal:en', 'normal'), row('pokemon:30c:091:reverse:en', 'reverse')]);

  const resolved = await printingsForIndexRow('pokemon:30c:091:normal:en');

  expect(resolved?.artId).toBe('pokemon:umbreon:30c-091-umbreon');
  expect(resolved?.printings.map((printing) => printing.id)).toEqual([
    'pokemon:30c:091:normal:en',
    'pokemon:30c:091:reverse:en',
  ]);
  // The lookup went by printing id, then by the artwork it belongs to.
  expect(getFirstAsync).toHaveBeenCalledWith(expect.stringContaining('WHERE p.id = ?'), ['pokemon:30c:091:normal:en']);
  expect(getAllAsync).toHaveBeenCalledWith(expect.stringContaining('WHERE c.art_id = ?'), ['pokemon:umbreon:30c-091-umbreon']);
});

it('puts the matched printing first even when it is not the newest', async () => {
  getFirstAsync.mockResolvedValue({ art_id: 'a' });
  getAllAsync.mockResolvedValue([row('pokemon:30c:091:normal:en', 'normal'), row('pokemon:30c:091:reverse:en', 'reverse')]);

  const resolved = await printingsForIndexRow('pokemon:30c:091:reverse:en');

  expect(resolved?.printings[0].id).toBe('pokemon:30c:091:reverse:en');
  expect(resolved?.printings).toHaveLength(2);
});

it('returns null when the printing is not in the local catalogue', async () => {
  getFirstAsync.mockResolvedValue(null);

  expect(await printingsForIndexRow('pokemon:unknown:001:normal:en')).toBeNull();
  expect(getAllAsync).not.toHaveBeenCalled();
});
