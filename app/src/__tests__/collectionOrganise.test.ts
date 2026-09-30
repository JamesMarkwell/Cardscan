import {
  NO_FILTERS,
  bestPrice,
  applyFilters,
  formatMoney,
  gamesPresent,
  rowValue,
  sortLabel,
  sortRows,
  summarise,
} from '../collection/organise';
import type { CollectionRow } from '../data/db';

let nextId = 1;
function row(over: Partial<CollectionRow> & { name?: string; setName?: string; number?: string; gameId?: string; rarity?: string | null }): CollectionRow {
  const id = nextId++;
  return {
    id,
    portfolioId: 1,
    printingId: `p${id}`,
    variant: 'normal',
    condition: 'NM',
    quantity: 1,
    costBasis: null,
    addedAt: `2026-01-0${id}T00:00:00Z`,
    market: 1,
    currency: 'GBP',
    printing: {
      id: `p${id}`,
      cardId: `c${id}`,
      gameId: (over.gameId ?? 'pokemon') as never,
      name: over.name ?? `Card ${id}`,
      setId: 's',
      setCode: 'SET',
      setName: over.setName ?? 'Base Set',
      number: over.number ?? String(id),
      setTotal: null,
      rarity: over.rarity ?? null,
      variant: 'normal',
      language: 'en',
      imageKey: null,
      tcgplayerProductId: null,
      cardmarketProductId: null,
    },
    ...over,
  } as CollectionRow;
}

const collection = () => [
  row({ name: 'Pikachu', quantity: 2, market: 5, setName: 'Base Set', number: '58', addedAt: '2026-01-01' }),
  row({ name: 'Charizard', quantity: 1, market: 200, setName: 'Base Set', number: '4', rarity: 'Rare Holo', addedAt: '2026-01-03' }),
  row({ name: 'Monkey D. Luffy', gameId: 'onepiece', quantity: 4, market: 3, setName: 'Romance Dawn', number: 'OP01-003', condition: 'LP', addedAt: '2026-01-02' }),
  row({ name: 'Mystery', quantity: 1, market: null, currency: null, addedAt: '2026-01-04' }),
];

describe('applyFilters', () => {
  it('returns everything with no filters', () => {
    expect(applyFilters(collection(), NO_FILTERS)).toHaveLength(4);
  });

  it('requires every word to match somewhere in the card', () => {
    const names = applyFilters(collection(), { ...NO_FILTERS, query: 'base holo' }).map((r) => r.printing.name);
    expect(names).toEqual(['Charizard']);
  });

  it('matches the serial number and ignores case', () => {
    expect(applyFilters(collection(), { ...NO_FILTERS, query: 'op01-003' })).toHaveLength(1);
  });

  it('filters by game and by condition', () => {
    expect(applyFilters(collection(), { ...NO_FILTERS, gameId: 'onepiece' })).toHaveLength(1);
    expect(applyFilters(collection(), { ...NO_FILTERS, condition: 'LP' })).toHaveLength(1);
    expect(applyFilters(collection(), { ...NO_FILTERS, gameId: 'pokemon', condition: 'LP' })).toHaveLength(0);
  });
});

describe('sortRows', () => {
  const names = (rows: CollectionRow[]) => rows.map((r) => r.printing.name);

  it('recent puts the newest first', () => {
    expect(names(sortRows(collection(), 'recent'))).toEqual(['Mystery', 'Charizard', 'Monkey D. Luffy', 'Pikachu']);
  });

  it('name is alphabetical', () => {
    expect(names(sortRows(collection(), 'name'))).toEqual(['Charizard', 'Monkey D. Luffy', 'Mystery', 'Pikachu']);
  });

  it('name Z–A reverses the alphabet', () => {
    expect(names(sortRows(collection(), 'nameDesc'))).toEqual(['Pikachu', 'Mystery', 'Monkey D. Luffy', 'Charizard']);
  });

  it('price high to low goes by one card, not the stack, with unpriced last', () => {
    // Charizard 200, Pikachu 5 (x2), Luffy 3 (x4 = 12 in total, still cheaper each)
    expect(names(sortRows(collection(), 'price'))).toEqual(['Charizard', 'Pikachu', 'Monkey D. Luffy', 'Mystery']);
  });

  it('price low to high keeps unpriced cards last too', () => {
    expect(names(sortRows(collection(), 'priceAsc'))).toEqual(['Monkey D. Luffy', 'Pikachu', 'Charizard', 'Mystery']);
  });

  it('quantity is most copies first', () => {
    expect(names(sortRows(collection(), 'quantity'))[0]).toBe('Monkey D. Luffy');
  });

  it('set groups by set then orders numbers numerically', () => {
    const rows = [
      row({ name: 'B', setName: 'Base Set', number: '10' }),
      row({ name: 'A', setName: 'Base Set', number: '9' }),
      row({ name: 'C', setName: 'Aaa Set', number: '1' }),
    ];
    expect(names(sortRows(rows, 'set'))).toEqual(['C', 'A', 'B']);
  });

  it('does not change the list it was given', () => {
    const rows = collection();
    const before = names(rows);
    sortRows(rows, 'name');
    expect(names(rows)).toEqual(before);
  });
});

describe('summarise', () => {
  it('counts copies, distinct rows, value and unpriced rows', () => {
    const summary = summarise(collection());
    expect(summary.cards).toBe(8);
    expect(summary.unique).toBe(4);
    expect(summary.value).toBe(222);
    expect(summary.unpriced).toBe(1);
    expect(summary.currency).toBe('GBP');
  });

  it('is zero for an empty collection', () => {
    expect(summarise([])).toMatchObject({ cards: 0, unique: 0, value: 0, unpriced: 0 });
  });
});

it('rowValue treats an unpriced card as worth nothing', () => {
  expect(rowValue(row({ market: null, quantity: 3 }))).toBe(0);
  expect(rowValue(row({ market: 2.5, quantity: 3 }))).toBe(7.5);
});

it('gamesPresent keeps only the games owned, in the given order', () => {
  expect(gamesPresent(collection(), ['onepiece', 'pokemon', 'mtg'])).toEqual(['onepiece', 'pokemon']);
});

it('formatMoney shows the currency symbol, or a dash with no price', () => {
  expect(formatMoney(12.5, 'GBP')).toBe('£12.50');
  expect(formatMoney(3, 'USD')).toBe('$3.00');
  expect(formatMoney(null, 'GBP')).toBe('—');
});

it('sortLabel names the sort', () => {
  expect(sortLabel('name')).toBe('Name A–Z');
  expect(sortLabel('price')).toBe('Price high to low');
});

describe('bestPrice', () => {
  const price = (source: 'tcgplayer' | 'cardmarket', over: Partial<{ market: number | null; trend: number | null; low: number | null; currency: string }>) => ({
    printingId: 'p', source, currency: 'USD', market: null, low: null, trend: null, avg7: null, avg30: null, asOf: '2026-09-30',
    ...over,
  });

  it('prefers Cardmarket, then TCGplayer', () => {
    const chosen = bestPrice([price('tcgplayer', { market: 5 }), price('cardmarket', { market: 4, currency: 'EUR' })]);
    expect(chosen).toEqual({ value: 4, currency: 'EUR' });
    expect(bestPrice([price('tcgplayer', { market: 5 })])).toEqual({ value: 5, currency: 'USD' });
  });

  it('falls back through market, trend and low, and to the other source when one is empty', () => {
    expect(bestPrice([price('tcgplayer', { low: 2 })])).toEqual({ value: 2, currency: 'USD' });
    expect(bestPrice([price('cardmarket', {}), price('tcgplayer', { market: 3 })])).toEqual({ value: 3, currency: 'USD' });
  });

  it('is null when nothing has a price', () => {
    expect(bestPrice([])).toBeNull();
    expect(bestPrice([price('tcgplayer', {})])).toBeNull();
  });
});
