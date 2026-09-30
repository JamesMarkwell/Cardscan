import { Printing } from '../data/types';
import { IndexPack } from '../scan/search';
import {
  chooseSerial,
  editDistance,
  nameSimilarity,
  nearSerialPatterns,
  parseOnePieceSerial,
  parseSerial,
  rankPrintingsBySerial,
  serialConfidence,
  serialSet,
} from '../scan/serial';

describe('parseOnePieceSerial', () => {
  it('reads a clean serial, including with other text on the line', () => {
    expect(parseOnePieceSerial(['OP17-070'])).toBe('OP17-070');
    expect(parseOnePieceSerial(['OP17-060 R CHARACTER'])).toBe('OP17-060');
    expect(parseOnePieceSerial(['Illustrator', 'ST36-003', 'C'])).toBe('ST36-003');
    expect(parseOnePieceSerial(['EB01-015'])).toBe('EB01-015');
    expect(parseOnePieceSerial(['PRB02-005'])).toBe('PRB02-005');
  });

  it('tolerates the ways OCR mangles a small serial', () => {
    expect(parseOnePieceSerial(['OP17 - 070'])).toBe('OP17-070'); // spaces around the hyphen
    expect(parseOnePieceSerial(['OP17–070'])).toBe('OP17-070'); // en dash
    expect(parseOnePieceSerial(['op17-070'])).toBe('OP17-070'); // lower case
    expect(parseOnePieceSerial(['0P17-070'])).toBe('OP17-070'); // zero for the O of OP
    expect(parseOnePieceSerial(['OP17-O70'])).toBe('OP17-070'); // letter O for a zero
    expect(parseOnePieceSerial(['OP1 7-07O'])).toBe('OP17-070');
    expect(parseOnePieceSerial(['OP17070'])).toBe('OP17-070'); // hyphen dropped
  });

  it('reads a promo serial', () => {
    expect(parseOnePieceSerial(['P-001'])).toBe('P-001');
  });

  it('does not mistake ordinary text for a serial', () => {
    expect(parseOnePieceSerial([])).toBeNull();
    expect(parseOnePieceSerial(['Scratchmen Apoo', 'CHARACTER', '7000', 'Ulti and Page One'])).toBeNull();
    expect(parseOnePieceSerial(['STRIKE 1000'])).toBeNull();
    expect(parseOnePieceSerial(['OPPONENT 2020'])).toBeNull();
  });

  it('uses the first line that holds a serial', () => {
    expect(parseOnePieceSerial(['nothing here', 'OP15-113', 'OP17-070'])).toBe('OP15-113');
  });
});

describe('parseSerial / serialSet', () => {
  it('only reads serials for games that print one', () => {
    expect(parseSerial('onepiece', ['OP17-070'])).toBe('OP17-070');
    expect(parseSerial('pokemon', ['OP17-070'])).toBeNull();
  });

  it('gives the set part of a serial', () => {
    expect(serialSet('OP17-070')).toBe('OP17');
    expect(serialSet('ST36-003')).toBe('ST36');
  });
});

function printing(id: string, setCode: string, variant: Printing['variant'] = 'normal'): Printing {
  return {
    id,
    cardId: 'onepiece:scratchmen-apoo',
    gameId: 'onepiece',
    name: 'Scratchmen Apoo',
    setId: `onepiece:${setCode}`,
    setCode,
    setName: setCode,
    number: 'OP17-070',
    setTotal: null,
    rarity: 'C',
    variant,
    language: 'en',
    imageKey: null,
    tcgplayerProductId: null,
    cardmarketProductId: null,
  };
}

/** A 2-dim index whose rows point in chosen directions. */
function pack(rows: Record<string, [number, number]>): IndexPack {
  const ids = Object.keys(rows);
  const matrix = new Float32Array(ids.length * 2);
  ids.forEach((id, row) => matrix.set(rows[id], row * 2));
  return { matrix, ids, dim: 2, version: 'test' };
}

describe('rankPrintingsBySerial', () => {
  const home = printing('onepiece:OP17:OP17070:normal:en', 'OP17');
  const reprint = printing('onepiece:OP17RE:OP17070:normal:en', 'OP17 RE');
  const foil = printing('onepiece:PRB02:OP17070:foil:en', 'PRB-02', 'foil');

  it('puts the printing whose artwork matches best first', () => {
    const embedding = Float32Array.from([1, 0]);
    // The reprint's artwork is a much closer match than the home printing's.
    const ranked = rankPrintingsBySerial(
      [home, reprint],
      'OP17-070',
      embedding,
      pack({ [home.id]: [0.2, 0.98], [reprint.id]: [0.99, 0.1] }),
    );
    expect(ranked.map((match) => match.printing.id)).toEqual([reprint.id, home.id]);
    expect(ranked[0].score).toBeCloseTo(0.99, 5);
  });

  it('prefers the serial’s own set when the artwork cannot separate them', () => {
    const embedding = Float32Array.from([1, 0]);
    const ranked = rankPrintingsBySerial(
      [reprint, home],
      'OP17-070',
      embedding,
      pack({ [home.id]: [0.9, 0.4], [reprint.id]: [0.9, 0.4] }),
    );
    expect(ranked[0].printing.id).toBe(home.id);
    expect(ranked[0].home).toBe(true);
    expect(ranked[1].home).toBe(false);
  });

  it('still ranks sensibly with no index rows at all: home set, then plain before foil', () => {
    const ranked = rankPrintingsBySerial([foil, reprint, home], 'OP17-070', Float32Array.from([1, 0]), pack({}));
    expect(ranked[0].printing.id).toBe(home.id);
    expect(ranked.every((match) => match.score === null)).toBe(true);
    expect(ranked.map((match) => match.printing.id).indexOf(reprint.id)).toBeLessThan(
      ranked.map((match) => match.printing.id).indexOf(foil.id),
    );
  });

  it('copes with no embedding or no index', () => {
    expect(rankPrintingsBySerial([home], 'OP17-070', null, null)).toHaveLength(1);
  });
});

describe('serialConfidence', () => {
  const home = printing('a', 'OP17');
  const other = printing('b', 'OP17 RE');

  it('is high when only one printing carries the serial', () => {
    const result = serialConfidence('OP17-070', [{ printing: home, score: 0.3, home: true }]);
    expect(result.tier).toBe('high');
    expect(result.reasons.join(' ')).toContain('OP17-070');
  });

  it('is high when the artwork clearly picks one of several', () => {
    const result = serialConfidence('OP17-070', [
      { printing: home, score: 0.8, home: true },
      { printing: other, score: 0.3, home: false },
    ]);
    expect(result.tier).toBe('high');
  });

  it('asks for a check when several printings look alike', () => {
    const result = serialConfidence('OP17-070', [
      { printing: home, score: 0.61, home: true },
      { printing: other, score: 0.6, home: false },
    ]);
    expect(result.tier).toBe('check');
  });
});

describe('editDistance', () => {
  it('counts single-character differences', () => {
    expect(editDistance('OP17-070', 'OP17-070')).toBe(0);
    expect(editDistance('OP17-070', 'OP12-070')).toBe(1);
    expect(editDistance('OP17-070', 'ST17-070')).toBe(2);
    expect(editDistance('', 'abc')).toBe(3);
  });
});

describe('nearSerialPatterns', () => {
  it('gives the serial itself and a wildcard for each digit', () => {
    expect(nearSerialPatterns('OP12-070')).toEqual([
      'OP12-070',
      'OP_2-070',
      'OP1_-070',
      'OP12-_70',
      'OP12-0_0',
      'OP12-07_',
    ]);
  });

  it('leaves the letters and hyphen alone', () => {
    expect(nearSerialPatterns('P-001')).toEqual(['P-001', 'P-_01', 'P-0_1', 'P-00_']);
  });
});

describe('nameSimilarity', () => {
  it('is 1 when the whole name is in the text, ignoring case and punctuation', () => {
    expect(nameSimilarity(['SCRATCHMEN  apoo', 'On-Air Pirates'], 'Scratchmen Apoo')).toBe(1);
  });

  it('gives partial credit for a partly read name', () => {
    expect(nameSimilarity(['men Apoo'], 'Scratchmen Apoo')).toBe(0.5);
  });

  it('forgives a slip or two in a longer word', () => {
    expect(nameSimilarity(['Scratchrnen Apoo'], 'Scratchmen Apoo')).toBe(1); // "m" read as "rn"
    expect(nameSimilarity(['Apco'], 'Apoo')).toBe(0); // too short to forgive
  });

  it('is 0 for a different card, and ignores short words', () => {
    expect(nameSimilarity(['Scratchmen Apoo', 'Animal Kingdom Pirates'], 'Monkey D Luffy')).toBe(0);
    expect(nameSimilarity(['and the one'], 'Ulti and Page One')).toBe(0); // only "ulti" and "page" count
    expect(nameSimilarity(['anything'], 'to be')).toBe(0);
  });
});

describe('chooseSerial', () => {
  const other = { ...printing('o', 'OP12'), name: 'Some Other Character', number: 'OP12-070' };
  const apoo = { ...printing('a', 'OP17'), name: 'Scratchmen Apoo', number: 'OP17-070' };

  it('takes the serial as read when nothing argues against it', () => {
    const choice = chooseSerial([other, apoo], 'OP12-070', ['OP12-070'], null, null);
    expect(choice).toMatchObject({ serial: 'OP12-070', exact: true, nameScore: 0 });
  });

  it('lets a matching name overrule a serial off by a digit', () => {
    const choice = chooseSerial([other, apoo], 'OP12-070', ['Scratchmen Apoo', 'OP12070'], null, null);
    expect(choice).toMatchObject({ serial: 'OP17-070', read: 'OP12-070', exact: false, nameScore: 1 });
  });

  it('lets the picture overrule when no name was read', () => {
    const pack2: IndexPack = { ids: ['o', 'a'], matrix: Float32Array.from([0.1, 0.1, 0.95, 0.3]), dim: 2, version: 't' };
    const choice = chooseSerial([other, apoo], 'OP12-070', [], Float32Array.from([1, 0]), pack2);
    expect(choice?.serial).toBe('OP17-070');
    expect(choice?.imageScore).toBeCloseTo(0.95, 5);
  });

  it('returns null with nothing to choose from', () => {
    expect(chooseSerial([], 'OP12-070', [], null, null)).toBeNull();
  });
});
