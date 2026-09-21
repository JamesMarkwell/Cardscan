/**
 * Printing disambiguation.
 *
 * The fingerprint identifies the artwork; it cannot tell two printings of the
 * same artwork apart. The set code and collector number in the card's bottom
 * strip can. This module owns (a) where to look per game, (b) how to read the
 * codes out of raw OCR lines, and (c) how to score printings against them.
 *
 * The OCR engine itself is behind `OcrProvider` so the parsing logic is
 * testable without a device and the engine can be swapped.
 */
import { GameId, Printing } from '../data/types';

export interface OcrBox {
  text: string;
}

export interface OcrProvider {
  /** Recognise text in a JPEG/PNG file and return the lines found. */
  recognise(imageUri: string): Promise<OcrBox[]>;
}

/** Normalised (left, top, width, height) of the strip worth reading, per game. */
export const OCR_REGIONS: Record<GameId, { left: number; top: number; width: number; height: number }> = {
  pokemon: { left: 0.0, top: 0.88, width: 1.0, height: 0.12 },
  onepiece: { left: 0.45, top: 0.86, width: 0.55, height: 0.14 },
  mtg: { left: 0.0, top: 0.86, width: 0.6, height: 0.14 },
  yugioh: { left: 0.0, top: 0.52, width: 1.0, height: 0.12 },
  lorcana: { left: 0.0, top: 0.88, width: 0.5, height: 0.12 },
};

export interface ParsedCorner {
  /** Set code as printed, upper-cased, e.g. "OP-07", "SVI", "LOB". */
  setCode: string | null;
  /** Collector number as printed, e.g. "025", "OP07-119". */
  number: string | null;
  /** "x/y" style total, useful for Pokemon where the set size identifies the set. */
  setTotal: string | null;
  language: string | null;
}

const NUMBER_OVER_TOTAL = /\b(\d{1,3})\s*\/\s*(\d{1,3})\b/;
// Set codes mix letters and digits (OP07, ST01), and some games put a language
// code between the set and the number (LOB-EN001).
const HYPHENATED = /\b([A-Z]{2,4}\d{0,2})[-–]([A-Z]{2})?(\d{1,4})\b/;
const SET_CODE = /\b([A-Z]{2,5})\b/;
const LEADING_NUMBER = /\b(\d{1,4})\b/;

const LANGUAGE_MARKERS: Array<[RegExp, string]> = [
  [/\bJP\b|日本語|ポケモン/, 'ja'],
  [/\bDE\b|\bDeutsch\b/i, 'de'],
  [/\bFR\b|\bFrançais\b/i, 'fr'],
  [/\bES\b|\bEspañol\b/i, 'es'],
  [/\bIT\b|\bItaliano\b/i, 'it'],
];

/** Pull a set code and collector number out of raw OCR lines. */
export function parseCornerText(boxes: OcrBox[]): ParsedCorner {
  const text = boxes
    .map((box) => box.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const upper = text.toUpperCase();

  const result: ParsedCorner = { setCode: null, number: null, setTotal: null, language: null };

  // "OP07-119" / "ST01-001" — One Piece prints both halves together.
  const hyphenated = upper.match(HYPHENATED);
  if (hyphenated) {
    result.setCode = hyphenated[1];
    result.number = hyphenated[3];
    if (hyphenated[2]) result.language = hyphenated[2].toLowerCase();
  }

  // "025/198" — Pokemon and Lorcana; the total identifies the set.
  const overTotal = upper.match(NUMBER_OVER_TOTAL);
  if (overTotal) {
    result.number = result.number ?? overTotal[1];
    result.setTotal = overTotal[2];
  }

  if (!result.setCode) {
    // Avoid matching rarity letters and the copyright line.
    const cleaned = upper.replace(/\b(THE|AND|FOR|INC|LTD|ILLUS|NM|EN|US)\b/g, ' ');
    const code = cleaned.match(SET_CODE);
    if (code) result.setCode = code[1];
  }

  if (!result.number) {
    const bare = upper.match(LEADING_NUMBER);
    if (bare) result.number = bare[1];
  }

  // A language code read out of the collector number is more reliable than a
  // loose marker elsewhere in the strip, so only fall back when it is missing.
  if (!result.language) {
    for (const [pattern, language] of LANGUAGE_MARKERS) {
      if (pattern.test(text)) {
        result.language = language;
        break;
      }
    }
  }

  return result;
}

/** Compare as printed, ignoring leading zeros and separators. */
export function numbersMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const normalise = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=\d)/, '');
  return normalise(a) === normalise(b);
}

export interface PrintingScore {
  printing: Printing;
  score: number;
  matchedOn: string[];
}

/**
 * Rank the candidate printings against what was read off the card. Returns an
 * empty array when nothing was readable, which the caller treats as "no OCR
 * evidence" rather than "disagreement".
 */
export function rankPrintings(printings: Printing[], parsed: ParsedCorner): PrintingScore[] {
  if (!parsed.setCode && !parsed.number && !parsed.setTotal) return [];

  return printings
    .map((printing) => {
      const matchedOn: string[] = [];
      let score = 0;

      if (parsed.setCode && printing.setCode.toUpperCase() === parsed.setCode) {
        score += 0.5;
        matchedOn.push('set');
      }
      if (numbersMatch(parsed.number, printing.number)) {
        score += 0.4;
        matchedOn.push('number');
      }
      if (parsed.setTotal && printing.setTotal && numbersMatch(parsed.setTotal, printing.setTotal)) {
        score += 0.2;
        matchedOn.push('setTotal');
      }
      if (parsed.language && printing.language === parsed.language) {
        score += 0.1;
        matchedOn.push('language');
      }

      return { printing, score, matchedOn };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * Whether the OCR evidence supports the chosen printing.
 * null means OCR produced nothing usable — not a disagreement.
 */
export function ocrAgreement(scores: PrintingScore[], chosen: Printing | null): boolean | null {
  if (scores.length === 0) return null;
  if (!chosen) return false;
  return scores[0].printing.id === chosen.id;
}
