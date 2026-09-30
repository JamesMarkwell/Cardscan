// The disk cache uses expo-file-system, which needs the native runtime; only the pure logic is tested here.
jest.mock('expo-file-system', () => ({ File: class {}, Paths: { document: '' } }));

import {
  FALLBACK_RATES,
  RATE_MAX_AGE_MS,
  convertAmount,
  parseRates,
  ratesAreStale,
} from '../data/currency';
import { withDisplayCurrency } from '../ui/CurrencyContext';

const RATES = { USD: 1, GBP: 0.8, EUR: 0.9 };

describe('convertAmount', () => {
  it('leaves an amount alone when it is already in the target currency', () => {
    expect(convertAmount(12.34, 'GBP', 'GBP', RATES)).toBe(12.34);
  });

  it('converts from US dollars', () => {
    expect(convertAmount(10, 'USD', 'GBP', RATES)).toBeCloseTo(8);
    expect(convertAmount(10, 'USD', 'EUR', RATES)).toBeCloseTo(9);
  });

  it('converts between two other currencies through the dollar', () => {
    // 8 GBP = 10 USD = 9 EUR
    expect(convertAmount(8, 'GBP', 'EUR', RATES)).toBeCloseTo(9);
  });

  it('passes an unknown or missing source currency through unchanged', () => {
    expect(convertAmount(5, 'JPY', 'GBP', RATES)).toBe(5);
    expect(convertAmount(5, null, 'GBP', RATES)).toBe(5);
  });
});

describe('parseRates', () => {
  it('reads the feed shape', () => {
    expect(parseRates({ base: 'USD', date: '2026-09-30', rates: { GBP: 0.74, EUR: 0.86 } })).toEqual({
      USD: 1,
      GBP: 0.74,
      EUR: 0.86,
    });
  });

  it('rejects anything that is not usable rates', () => {
    expect(parseRates(null)).toBeNull();
    expect(parseRates({})).toBeNull();
    expect(parseRates({ rates: { GBP: 0, EUR: 0.9 } })).toBeNull();
    expect(parseRates({ rates: { GBP: 'x', EUR: 0.9 } })).toBeNull();
  });
});

describe('ratesAreStale', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const at = (msAgo: number) => ({ rates: RATES, fetchedAt: new Date(now - msAgo).toISOString() });

  it('is stale when nothing has ever been fetched', () => {
    expect(ratesAreStale({ rates: FALLBACK_RATES, fetchedAt: null }, now)).toBe(true);
  });

  it('is fresh within the max age and stale beyond it', () => {
    expect(ratesAreStale(at(RATE_MAX_AGE_MS - 1000), now)).toBe(false);
    expect(ratesAreStale(at(RATE_MAX_AGE_MS + 1000), now)).toBe(true);
  });

  it('treats a fetch time in the future (a wrong clock) as stale', () => {
    expect(ratesAreStale(at(-60_000), now)).toBe(true);
  });
});

describe('withDisplayCurrency', () => {
  const display = { currency: 'GBP' as const, rates: RATES };

  it('converts the price and relabels it with the display currency', () => {
    expect(withDisplayCurrency({ market: 10, currency: 'USD', name: 'x' }, display)).toEqual({
      market: 8,
      currency: 'GBP',
      name: 'x',
    });
  });

  it('keeps an unpriced item unpriced but in the display currency', () => {
    expect(withDisplayCurrency({ market: null, currency: 'USD' }, display)).toEqual({ market: null, currency: 'GBP' });
  });
});
