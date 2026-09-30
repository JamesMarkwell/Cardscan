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

  const scored = printings.map(
    (printing): SerialMatch => ({
      printing,
      score: imageSimilarity(printing, embedding, pack),
      home: compactSetCode(printing.setCode) === set,
    }),
  );

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
export function serialConfidence(
  serial: string,
  ranked: SerialMatch[],
  corroboration?: SerialChoice,
): ConfidenceResult {
  const top = ranked[0];
  const second = ranked[1];
  const topScore = top?.score ?? 0;
  const gap = top && second && top.score !== null && second.score !== null ? top.score - second.score : 0;
  const reasons = [`serial ${serial} read from the card`];

  // Which printing of the card is the smaller doubt...
  let tier: ConfidenceResult['tier'];
  let score: number;
  if (ranked.length === 1) {
    reasons.push('only one printing has it');
    tier = 'high';
    score = 0.95;
  } else {
    reasons.push(`${ranked.length} printings share it`);
    if (gap >= CLEAR_LEAD) {
      reasons.push('artwork picks one');
      tier = 'high';
      score = 0.9;
    } else {
      reasons.push('printings look alike — check which');
      tier = 'check';
      score = 0.7;
    }
  }

  // ...the bigger one is whether the serial was read right. Text this small is
  // misread often, and a misread can land on a real serial of another card, so a
  // serial only earns "high" when something independent agrees with it.
  if (corroboration) {
    const namesIt = corroboration.nameScore >= NAME_AGREES;
    const looksLikeIt = (corroboration.imageScore ?? 0) >= IMAGE_AGREES;
    if (!corroboration.exact) {
      reasons.push(`read as ${corroboration.read}, but the card name matches ${serial}`);
      if (corroboration.nameScore < NAME_CONFIDENT) {
        tier = 'check';
        score = Math.min(score, 0.7);
      }
    } else if (namesIt) {
      reasons.push('card name agrees');
    } else if (looksLikeIt) {
      reasons.push('picture agrees');
    } else {
      reasons.push('serial not yet confirmed by the name or picture');
      tier = 'check';
      score = Math.min(score, 0.7);
    }
  }

  return { tier, score, topScore, gap: ranked.length === 1 ? topScore : gap, reasons };
}

// How much of a card's name must appear in the text read off the card to count as
// the name agreeing with the serial, and how much to be sure enough to overrule it.
const NAME_AGREES = 0.5;
const NAME_CONFIDENT = 0.7;
// Picture similarity that, on its own, supports a serial (the image match is weak
// on real photos, so this is a high bar).
const IMAGE_AGREES = 0.6;

/** Levenshtein distance between two short strings. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/** Whether `needle` appears in `haystack` allowing up to `maxEdits` character errors. */
function containsApproximately(haystack: string, needle: string, maxEdits: number): boolean {
  if (needle.length === 0) return true;
  // Approximate substring matching: the match may start anywhere in the haystack.
  let previous = Array.from({ length: needle.length + 1 }, (_, i) => i);
  if (previous[needle.length] <= maxEdits) return true;
  for (let i = 1; i <= haystack.length; i += 1) {
    const current = [0];
    for (let j = 1; j <= needle.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (haystack[i - 1] === needle[j - 1] ? 0 : 1),
      );
    }
    if (current[needle.length] <= maxEdits) return true;
    previous = current;
  }
  return false;
}

function alphanumeric(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * How much of a card's name shows up in the text read off the card, 0 to 1: the
 * share of its words found, allowing for OCR slips (longer words tolerate more).
 * Short words are ignored — they turn up in any text.
 */
export function nameSimilarity(ocrLines: string[], name: string): number {
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4);
  if (words.length === 0) return 0;

  const lines = ocrLines.map(alphanumeric);
  const found = words.filter((word) => {
    const allowed = word.length >= 8 ? 2 : word.length >= 5 ? 1 : 0;
    return lines.some((line) => containsApproximately(line, word, allowed));
  });
  return found.length / words.length;
}

/**
 * SQL LIKE patterns that match a serial and every serial one digit away from it
 * ("OP12-070" -> "OP_2-070", "OP1_-070", …). Small print is misread a digit at a
 * time, so these are the serials worth considering alongside the one that was read.
 */
export function nearSerialPatterns(serial: string): string[] {
  const patterns = [serial];
  for (let i = 0; i < serial.length; i += 1) {
    if (/\d/.test(serial[i])) patterns.push(`${serial.slice(0, i)}_${serial.slice(i + 1)}`);
  }
  return patterns;
}

/** What settled a serial, and how strongly the rest of the evidence backed it. */
export interface SerialChoice {
  /** The serial chosen — the one read, or a near miss the evidence preferred. */
  serial: string;
  /** The serial as read off the card. */
  read: string;
  /** Whether the chosen serial is exactly the one read. */
  exact: boolean;
  /** How much of the chosen card's name appears in the text read (0-1). */
  nameScore: number;
  /** Picture similarity to the chosen card, or null if it has no index row. */
  imageScore: number | null;
}

// How much each kind of evidence counts when choosing among the serials near the
// one read. The name is the strongest: it is long, printed large, and independent
// of the small print that gets misread. The serial as read still counts — it is
// right most of the time — and the picture, weak on real photos, only nudges.
const NAME_WEIGHT = 1.0;
const EXACT_WEIGHT = 0.4;
const IMAGE_WEIGHT = 0.6;

function imageSimilarity(printing: Printing, embedding: Float32Array | null, pack: IndexPack | null): number | null {
  if (!embedding || !pack || pack.dim !== embedding.length) return null;
  const row = rowFor(pack, printing.id);
  if (row === undefined) return null;
  let dot = 0;
  const base = row * pack.dim;
  for (let d = 0; d < pack.dim; d += 1) dot += pack.matrix[base + d] * embedding[d];
  return dot;
}

/**
 * Choose the serial to trust from the printings carrying the serial that was read
 * or one a digit away from it. The name printed on the card usually settles it
 * when the read serial is off by a digit; with no readable name, the serial as
 * read wins unless the picture points elsewhere.
 */
export function chooseSerial(
  printings: Printing[],
  read: string,
  ocrLines: string[],
  embedding: Float32Array | null,
  pack: IndexPack | null,
): SerialChoice | null {
  let best: { printing: Printing; score: number; nameScore: number; imageScore: number | null } | null = null;

  for (const printing of printings) {
    const nameScore = nameSimilarity(ocrLines, printing.name);
    const imageScore = imageSimilarity(printing, embedding, pack);
    const score =
      NAME_WEIGHT * nameScore + EXACT_WEIGHT * (printing.number === read ? 1 : 0) + IMAGE_WEIGHT * (imageScore ?? 0);
    if (!best || score > best.score) best = { printing, score, nameScore, imageScore };
  }

  if (!best) return null;
  return {
    serial: best.printing.number,
    read,
    exact: best.printing.number === read,
    nameScore: best.nameScore,
    imageScore: best.imageScore,
  };
}
