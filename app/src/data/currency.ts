/**
 * Showing prices in the currency chosen in Settings.
 *
 * Prices are stored in the currency their source gave (TCGplayer: USD), and
 * converted only for display, so a rate change never rewrites stored data. Rates
 * are fetched from a free public feed (ECB reference rates via Frankfurter), kept
 * on disk with the time they were fetched, and refreshed when older than half a
 * day. When there is no fetched rate — first launch offline — approximate built-in
 * rates are used so prices still show in the chosen currency.
 */
import { File, Paths } from 'expo-file-system';

export type CurrencyCode = 'GBP' | 'USD' | 'EUR';

/** How many units of each currency one US dollar buys. */
export type Rates = Record<CurrencyCode, number>;

export interface StoredRates {
  rates: Rates;
  /** ISO time the rates were fetched, or null for the built-in fallback. */
  fetchedAt: string | null;
}

/** Approximate; used only until real rates have been fetched. */
export const FALLBACK_RATES: Rates = { USD: 1, GBP: 0.75, EUR: 0.86 };

export const RATE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const RATES_URL = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=GBP,EUR';

/** Convert an amount from one currency to another. Unknown currencies pass through unchanged. */
export function convertAmount(amount: number, from: string | null, to: CurrencyCode, rates: Rates): number {
  if (!from || from === to) return amount;
  const fromRate = rates[from as CurrencyCode];
  const toRate = rates[to];
  if (!fromRate || !toRate) return amount;
  return (amount / fromRate) * toRate;
}

/** Whether stored rates are missing or old enough to fetch again. */
export function ratesAreStale(stored: StoredRates, now: number = Date.now()): boolean {
  if (!stored.fetchedAt) return true;
  const age = now - new Date(stored.fetchedAt).getTime();
  return !Number.isFinite(age) || age > RATE_MAX_AGE_MS || age < 0;
}

/** Read the feed's JSON into rates; null when it is not in the shape we expect. */
export function parseRates(payload: unknown): Rates | null {
  const rates = (payload as { rates?: Record<string, unknown> } | null)?.rates;
  const gbp = Number(rates?.GBP);
  const eur = Number(rates?.EUR);
  if (!(gbp > 0) || !(eur > 0)) return null;
  return { USD: 1, GBP: gbp, EUR: eur };
}

function ratesFile(): File {
  return new File(Paths.document, 'rates.json');
}

export function loadRates(): StoredRates {
  try {
    const file = ratesFile();
    if (!file.exists) return { rates: FALLBACK_RATES, fetchedAt: null };
    const stored = JSON.parse(file.textSync()) as StoredRates;
    const rates = parseRates({ rates: stored.rates });
    if (!rates || typeof stored.fetchedAt !== 'string') return { rates: FALLBACK_RATES, fetchedAt: null };
    return { rates, fetchedAt: stored.fetchedAt };
  } catch {
    return { rates: FALLBACK_RATES, fetchedAt: null };
  }
}

function saveRates(stored: StoredRates): void {
  try {
    const file = ratesFile();
    if (!file.exists) file.create({ intermediates: true, overwrite: true });
    file.write(JSON.stringify(stored));
  } catch {
    // Not being able to cache is harmless; we just fetch again next time.
  }
}

/** Fetch fresh rates. Resolves to null on any failure — the caller keeps what it had. */
export async function fetchRates(): Promise<StoredRates | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(RATES_URL, { signal: controller.signal });
      if (!response.ok) return null;
      const rates = parseRates(await response.json());
      if (!rates) return null;
      const stored = { rates, fetchedAt: new Date().toISOString() };
      saveRates(stored);
      return stored;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
