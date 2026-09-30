/**
 * Sorting, filtering and totals for the collection list. Pure functions over the
 * rows the database returns, so the screen stays thin and this is easy to test.
 */
import type { CollectionRow } from '../data/db';
import type { Condition, GameId, Price } from '../data/types';

export type SortKey = 'recent' | 'name' | 'nameDesc' | 'price' | 'priceAsc' | 'quantity' | 'set';

export const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'name', label: 'Name A–Z' },
  { key: 'nameDesc', label: 'Name Z–A' },
  { key: 'price', label: 'Price high to low' },
  { key: 'priceAsc', label: 'Price low to high' },
  { key: 'recent', label: 'Recently added' },
  { key: 'quantity', label: 'Quantity' },
  { key: 'set', label: 'Set' },
];

export interface CollectionFilters {
  /** Free text: every word must appear in the name, set, number or rarity. */
  query: string;
  gameId: GameId | null;
  condition: Condition | null;
}

export const NO_FILTERS: CollectionFilters = { query: '', gameId: null, condition: null };

/** What a row is worth: the market price times how many are owned (0 when unpriced). */
export function rowValue(row: CollectionRow): number {
  return (row.market ?? 0) * row.quantity;
}

export function applyFilters(rows: CollectionRow[], filters: CollectionFilters): CollectionRow[] {
  const words = filters.query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    if (filters.gameId && row.printing.gameId !== filters.gameId) return false;
    if (filters.condition && row.condition !== filters.condition) return false;
    if (words.length === 0) return true;
    const haystack = [
      row.printing.name,
      row.printing.setName,
      row.printing.setCode,
      row.printing.number,
      row.printing.rarity ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function sortRows(rows: CollectionRow[], key: SortKey): CollectionRow[] {
  const byName = (a: CollectionRow, b: CollectionRow) => a.printing.name.localeCompare(b.printing.name);
  const sorted = [...rows];
  switch (key) {
    case 'name':
      return sorted.sort(byName);
    case 'nameDesc':
      return sorted.sort((a, b) => byName(b, a));
    case 'price':
    case 'priceAsc': {
      // By what one card costs, not the stack; unpriced cards last either way.
      const direction = key === 'price' ? -1 : 1;
      return sorted.sort((a, b) => {
        if ((a.market === null) !== (b.market === null)) return a.market === null ? 1 : -1;
        return direction * ((a.market ?? 0) - (b.market ?? 0)) || byName(a, b);
      });
    }
    case 'quantity':
      return sorted.sort((a, b) => b.quantity - a.quantity || byName(a, b));
    case 'set':
      return sorted.sort(
        (a, b) =>
          a.printing.setName.localeCompare(b.printing.setName) ||
          a.printing.number.localeCompare(b.printing.number, undefined, { numeric: true }) ||
          byName(a, b),
      );
    case 'recent':
    default:
      return sorted.sort((a, b) => b.addedAt.localeCompare(a.addedAt) || b.id - a.id);
  }
}

export interface CollectionSummary {
  /** Every card owned, counting copies. */
  cards: number;
  /** Distinct collection rows. */
  unique: number;
  value: number;
  currency: string;
  /** How many owned rows have no price. */
  unpriced: number;
}

export function summarise(rows: CollectionRow[]): CollectionSummary {
  return {
    cards: rows.reduce((total, row) => total + row.quantity, 0),
    unique: rows.length,
    value: rows.reduce((total, row) => total + rowValue(row), 0),
    currency: rows.find((row) => row.currency)?.currency ?? 'GBP',
    unpriced: rows.filter((row) => row.market === null).length,
  };
}

/** The games present in the collection, in the order they first appear in `order`. */
export function gamesPresent(rows: CollectionRow[], order: GameId[]): GameId[] {
  const present = new Set(rows.map((row) => row.printing.gameId));
  return order.filter((game) => present.has(game));
}

export function currencySymbol(currency: string | null): string {
  if (currency === 'GBP') return '£';
  if (currency === 'EUR') return '€';
  return '$';
}

export function formatMoney(amount: number | null, currency: string | null): string {
  return amount === null ? '—' : `${currencySymbol(currency)}${amount.toFixed(2)}`;
}

/** The label for a sort key, for showing the current choice. */
export function sortLabel(key: SortKey): string {
  return SORTS.find((sort) => sort.key === key)?.label ?? '';
}

/** The price to show: Cardmarket's if we have it, otherwise TCGplayer's. */
export function bestPrice(prices: Price[]): { value: number; currency: string } | null {
  const ordered = [...prices].sort((a, b) => (a.source === 'cardmarket' ? -1 : 1) - (b.source === 'cardmarket' ? -1 : 1));
  for (const price of ordered) {
    const value = price.market ?? price.trend ?? price.low;
    if (value !== null && value !== undefined) return { value, currency: price.currency };
  }
  return null;
}
