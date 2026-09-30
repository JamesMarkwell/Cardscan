/**
 * Reading a card's printed serial, and using it to pick the printing.
 *
 * Some games print a code that identifies the card almost exactly — One Piece's
 * "OP17-070" names the set and the card in it. That is far stronger evidence than
 * a picture match, which is weak on real photos of these cards, so it is checked
 * first: the serial narrows the catalogue to the handful of printings that carry
 * it (the original, reprints in other sets, foil and alternate-art versions), and
 * the image match then only has to choose among those.
 *
 * Kept free of native code so it can be tested off-device; reading the text out of
 * the image is done by serialOcr.ts.
 */
import { GameId, Printing } from '../data/types';
import { ConfidenceResult } from './confidence';
import { IndexPack } from './search';

/** Games whose cards print a serial we know how to read and look up. */
export const SERIAL_GAMES: ReadonlySet<GameId> = new Set<GameId>(['onepiece']);

// OCR reads a digit as a look-alike letter fairly often, in a small typeface.
const DIGIT_LOOKALIKES: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2' };
const LOOKALIKE_CLASS = '0-9OQDILSBZ';

function fixDigits(text: string): string {
  return text
    .split('')
    .map((char) => DIGIT_LOOKALIKES[char] ?? char)
    .join('');
}

/**
 * Find a One Piece serial (OP17-070, ST36-003, EB01-015, PRB02-…, or a promo like
 * P-001) in raw OCR lines, and return it in the catalogue's form. Null if none of
 * the lines contains one.
 */
export function parseOnePieceSerial(lines: string[]): string | null {
  // Letters that stand in for digits are only trusted next to a hyphen; without
  // one the digits must be real, so ordinary words are not mistaken for a code.
  const withHyphen = new RegExp(`(0P|OP|ST|EB|PRB)([${LOOKALIKE_CLASS}]{2})-([${LOOKALIKE_CLASS}]{3})(?![0-9])`);
  const withoutHyphen = /(OP|ST|EB|PRB)(\d{2})(\d{3})(?!\d)/;
  const promo = /(?:^|[^A-Z])P-(\d{3})(?!\d)/;

  for (const line of lines) {
    // Dashes come out as several characters, and spaces creep into the code.
    const compact = line
      .toUpperCase()
      .replace(/[–—−‐‑_]/g, '-')
      .replace(/\s+/g, '');

    const hyphenated = compact.match(withHyphen);
    if (hyphenated) {
      const prefix = hyphenated[1] === '0P' ? 'OP' : hyphenated[1];
      return `${prefix}${fixDigits(hyphenated[2])}-${fixDigits(hyphenated[3])}`;
    }

    const unhyphenated = compact.match(withoutHyphen);
    if (unhyphenated) return `${unhyphenated[1]}${unhyphenated[2]}-${unhyphenated[3]}`;

    const promoMatch = line.toUpperCase().replace(/\s+/g, '').match(promo);
    if (promoMatch) return `P-${promoMatch[1]}`;
  }
  return null;
}

/** Read the serial for a game out of raw OCR lines; null for games without one. */
export function parseSerial(game: GameId, lines: string[]): string | null {
  if (game === 'onepiece') return parseOnePieceSerial(lines);
  return null;
}

/** The set part of a serial: "OP17-070" -> "OP17". */
export function serialSet(serial: string): string {
  return serial.split('-')[0];
}

/** A printing's set code with separators removed, to compare with a serial's set. */
function compactSetCode(setCode: string): string {
  return setCode.toUpperCase().replace(/[\s-]/g, '');
}

export interface SerialMatch {
  printing: Printing;
  /** Cosine similarity to the scanned card's image; null if it has no index row. */
  score: number | null;
  /** Whether this printing is from the set the serial names (not a reprint elsewhere). */
  home: boolean;
}

// The index maps rows by printing id; building the lookup once per pack keeps a
// scan from re-walking tens of thousands of ids.
const rowLookups = new WeakMap<IndexPack, Map<string, number>>();

function rowFor(pack: IndexPack, printingId: string): number | undefined {
  let lookup = rowLookups.get(pack);
  if (!lookup) {
    lookup = new Map(pack.ids.map((id, row) => [id, row] as const));
    rowLookups.set(pack, lookup);
  }
  return lookup.get(printingId);
}

// A small nudge toward the printing from the set the serial names, so that when
// the image match cannot separate two printings the original wins over a reprint.
const HOME_SET_BONUS = 0.05;

/**
 * Order the printings that share a serial, best first.
 *
 * The image match decides among them — an alternate art scores far higher against
 * its own artwork than against the standard one — with the serial's own set as a
 * tie-break, and plain (non-foil) printings ahead of foil when nothing else
 * separates them.
 */
export function rankPrintingsBySerial(
  printings: Printing[],
  serial: string,
  embedding: Float32Array | null,
  pack: IndexPack | null,
): SerialMatch[] {
  const set = serialSet(serial);

  const scored = printings.map((printing): SerialMatch => {
    let score: number | null = null;
    if (embedding && pack && pack.dim === embedding.length) {
      const row = rowFor(pack, printing.id);
      if (row !== undefined) {
        let dot = 0;
        const base = row * pack.dim;
        for (let d = 0; d < pack.dim; d += 1) dot += pack.matrix[base + d] * embedding[d];
        score = dot;
      }
    }
    return { printing, score, home: compactSetCode(printing.setCode) === set };
  });

  const key = (match: SerialMatch) => (match.score ?? -1) + (match.home ? HOME_SET_BONUS : 0);
  return scored.sort((a, b) => {
    const difference = key(b) - key(a);
    if (difference !== 0) return difference;
    // Nothing separates them: plain before foil, otherwise keep catalogue order.
    return Number(b.printing.variant === 'normal') - Number(a.printing.variant === 'normal');
  });
}

/** How far ahead of the runner-up the best printing must be to call it clear. */
const CLEAR_LEAD = 0.03;

/**
 * Confidence for a serial match. The serial pins the card, so what is left to
 * doubt is only which printing of it: one printing, or a clear leader, is high;
 * several that the image match cannot separate is "check".
 */
export function serialConfidence(serial: string, ranked: SerialMatch[]): ConfidenceResult {
  const top = ranked[0];
  const second = ranked[1];
  const topScore = top?.score ?? 0;
  const gap = top && second && top.score !== null && second.score !== null ? top.score - second.score : 0;
  const reasons = [`serial ${serial} read from the card`];

  if (ranked.length === 1) {
    reasons.push('only one printing has it');
    return { tier: 'high', score: 0.95, topScore, gap: topScore, reasons };
  }

  reasons.push(`${ranked.length} printings share it`);
  if (gap >= CLEAR_LEAD) {
    reasons.push('artwork picks one');
    return { tier: 'high', score: 0.9, topScore, gap, reasons };
  }
  reasons.push('printings look alike — check which');
  return { tier: 'check', score: 0.7, topScore, gap, reasons };
}
