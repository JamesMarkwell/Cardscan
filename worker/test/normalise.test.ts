import { describe, expect, it } from 'vitest';
import {
  matchKey,
  normaliseName,
  normaliseNumber,
  normaliseSetCode,
  parseMoney,
  printingId,
  splitNumber,
  variantFromProductName,
} from '../src/normalise';

describe('normaliseNumber', () => {
  it('strips separators and leading zeros', () => {
    expect(normaliseNumber('025')).toBe('25');
    expect(normaliseNumber('OP07-119')).toBe('OP07119');
  });
});

describe('normaliseName', () => {
  it('folds accents, case and punctuation', () => {
    expect(normaliseName('Pokémon: Charizard ex')).toBe('pokemon charizard ex');
    expect(normaliseName('Monkey.D.Luffy')).toBe('monkey d luffy');
  });
});

describe('splitNumber', () => {
  it('splits number over total', () => {
    expect(splitNumber('025/198')).toEqual({ number: '025', total: '198' });
  });

  it('leaves a plain number alone', () => {
    expect(splitNumber('OP07-119')).toEqual({ number: 'OP07-119', total: null });
  });

  it('tolerates spaces around the slash', () => {
    expect(splitNumber(' 25 / 198 ')).toEqual({ number: '25', total: '198' });
  });
});

describe('variantFromProductName', () => {
  it('defaults to normal rather than guessing', () => {
    expect(variantFromProductName('Charizard')).toBe('normal');
  });

  it('recognises reverse holo before plain holo', () => {
    expect(variantFromProductName('Pikachu (Reverse Holo)')).toBe('reverse');
    expect(variantFromProductName('Pikachu (Holo)')).toBe('foil');
  });

  it('recognises first edition', () => {
    expect(variantFromProductName('Blue-Eyes White Dragon (1st Edition)')).toBe('first_edition');
  });
});

describe('printingId', () => {
  it('is stable across formatting differences in the source', () => {
    expect(printingId('pokemon', 'sv1', '025', 'normal', 'en')).toBe(
      printingId('pokemon', 'SV-1', '25', 'normal', 'en'),
    );
  });

  it('keeps variants apart', () => {
    expect(printingId('pokemon', 'SV1', '25', 'foil', 'en')).not.toBe(
      printingId('pokemon', 'SV1', '25', 'normal', 'en'),
    );
  });
});

describe('matchKey', () => {
  it('joins the same card written differently by two sources', () => {
    expect(matchKey('OP-07', '119', 'Monkey D. Luffy')).toBe(matchKey('op07', '0119', 'Monkey D Luffy'));
  });
});

describe('normaliseSetCode', () => {
  it('drops punctuation', () => {
    expect(normaliseSetCode('OP-07')).toBe('OP07');
  });
});

describe('parseMoney', () => {
  it('accepts numbers and numeric strings', () => {
    expect(parseMoney(1.5)).toBe(1.5);
    expect(parseMoney('2.25')).toBe(2.25);
  });

  it('rejects blanks and nonsense rather than storing a zero', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney(null)).toBeNull();
    expect(parseMoney('n/a')).toBeNull();
    expect(parseMoney(-1)).toBeNull();
  });
});
