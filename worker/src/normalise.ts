/**
 * Turning source rows into catalog rows.
 *
 * Cross-source matching is deliberately conservative: set code plus collector
 * number plus name, and anything that does not line up goes to the `unmatched`
 * table for a human to look at. A wrong join here becomes a wrong price in the
 * app, which is worse than a missing one.
 */
import { GameId } from './types';

/** Collector numbers print inconsistently; compare them stripped. */
export function normaliseNumber(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^0+(?=\d)/, '');
}

export function normaliseName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normaliseSetCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Stable, readable ids so a re-import does not duplicate rows. */
export function printingId(game: GameId, setCode: string, number: string, variant: string, language: string): string {
  return [game, normaliseSetCode(setCode), normaliseNumber(number), variant, language].join(':');
}

export function setId(game: GameId, code: string): string {
  return `${game}:${normaliseSetCode(code)}`;
}

/**
 * Key used to join the same physical card across TCGplayer, Cardmarket and
 * Scryfall.
 */
export function matchKey(setCode: string, number: string, name: string): string {
  return `${normaliseSetCode(setCode)}|${normaliseNumber(number)}|${normaliseName(name)}`;
}

const VARIANT_PATTERNS: Array<[RegExp, string]> = [
  [/reverse\s*holo|reverse\s*foil/i, 'reverse'],
  [/1st\s*edition|first\s*edition/i, 'first_edition'],
  [/foil|holo|hyper|prism|cold\s*foil/i, 'foil'],
];

/**
 * Work out the variant from a product name suffix. Defaults to normal: the plan
 * is to pre-select foil only when the printing is foil-only, because guessing
 * from appearance is unreliable.
 */
export function variantFromProductName(productName: string): string {
  for (const [pattern, variant] of VARIANT_PATTERNS) {
    if (pattern.test(productName)) return variant;
  }
  return 'normal';
}

/** "025/198" -> { number: "025", total: "198" } */
export function splitNumber(raw: string): { number: string; total: string | null } {
  const match = raw.match(/^\s*([A-Za-z0-9\-]+?)\s*\/\s*([A-Za-z0-9]+)\s*$/);
  if (match) return { number: match[1], total: match[2] };
  return { number: raw.trim(), total: null };
}

/**
 * Prices arrive in the source's own currency. We store what we were given plus
 * its currency rather than converting on ingest, so a later rate change cannot
 * silently rewrite history.
 */
export function parseMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
