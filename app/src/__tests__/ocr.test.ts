import { numbersMatch, ocrAgreement, parseCornerText, rankPrintings } from '../scan/ocr';
import { Printing } from '../data/types';

function printing(overrides: Partial<Printing>): Printing {
  return {
    id: 'p1',
    cardId: 'c1',
    gameId: 'onepiece',
    name: 'Monkey D. Luffy',
    setId: 's1',
    setCode: 'OP07',
    setName: 'The 500 Year Future',
    number: '119',
    setTotal: null,
    rarity: 'SR',
    variant: 'normal',
    language: 'en',
    imageKey: null,
    tcgplayerProductId: null,
    cardmarketProductId: null,
    ...overrides,
  };
}

describe('parseCornerText', () => {
  it('reads a One Piece style hyphenated code', () => {
    const parsed = parseCornerText([{ text: 'OP07-119' }, { text: 'SR' }]);
    expect(parsed.setCode).toBe('OP07');
    expect(parsed.number).toBe('119');
  });

  it('reads a Pokemon style number over set total', () => {
    const parsed = parseCornerText([{ text: '025/198' }]);
    expect(parsed.number).toBe('025');
    expect(parsed.setTotal).toBe('198');
  });

  it('copes with OCR spacing around the slash', () => {
    expect(parseCornerText([{ text: '25 / 198' }]).setTotal).toBe('198');
  });

  it('picks up a Japanese marker', () => {
    expect(parseCornerText([{ text: 'OP07-119 日本語' }]).language).toBe('ja');
  });

  it('returns nulls when nothing usable was read', () => {
    const parsed = parseCornerText([{ text: '...' }]);
    expect(parsed.setCode).toBeNull();
    expect(parsed.number).toBeNull();
  });
});

describe('numbersMatch', () => {
  it('ignores leading zeros and separators', () => {
    expect(numbersMatch('025', '25')).toBe(true);
    expect(numbersMatch('OP07-119', 'op07119')).toBe(true);
  });

  it('is false when either side is missing', () => {
    expect(numbersMatch(null, '25')).toBe(false);
    expect(numbersMatch('25', null)).toBe(false);
  });

  it('does not match different numbers', () => {
    expect(numbersMatch('025', '250')).toBe(false);
  });
});

describe('rankPrintings', () => {
  const reprints = [
    printing({ id: 'op07-119', setCode: 'OP07', number: '119' }),
    printing({ id: 'p-001', setCode: 'P', number: '001' }),
  ];

  it('puts the printing whose set and number were read first', () => {
    const ranked = rankPrintings(reprints, parseCornerText([{ text: 'OP07-119' }]));
    expect(ranked[0].printing.id).toBe('op07-119');
    expect(ranked[0].matchedOn).toEqual(expect.arrayContaining(['set', 'number']));
  });

  it('returns nothing when the OCR produced nothing — that is not a disagreement', () => {
    expect(rankPrintings(reprints, parseCornerText([{ text: '' }]))).toEqual([]);
  });
});

describe('ocrAgreement', () => {
  const chosen = printing({ id: 'op07-119' });

  it('is null when there was no OCR evidence at all', () => {
    expect(ocrAgreement([], chosen)).toBeNull();
  });

  it('is true when the OCR favourite is the chosen printing', () => {
    expect(ocrAgreement([{ printing: chosen, score: 0.9, matchedOn: ['set'] }], chosen)).toBe(true);
  });

  it('is false when the OCR favours a different printing', () => {
    const other = printing({ id: 'p-001' });
    expect(ocrAgreement([{ printing: other, score: 0.9, matchedOn: ['set'] }], chosen)).toBe(false);
  });
});
