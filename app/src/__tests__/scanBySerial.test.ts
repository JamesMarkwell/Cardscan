/**
 * The scan service checks the printed serial first.
 *
 * Driven end to end with a fake serial reader and a fake catalogue: the serial
 * picks the card and the picture match only chooses among printings that share it,
 * and a card whose serial cannot be read (or is not in the catalogue) falls back
 * to the picture match.
 */
import { Printing } from '../data/types';
import { ScanPipeline } from '../scan/pipeline';
import { ScanService, SerialReader } from '../scan/scanService';
import { IndexPack } from '../scan/search';

jest.mock('../data/db', () => ({
  printingsMatchingSerials: jest.fn(),
  printingsForIndexRow: jest.fn(),
}));
// The pipeline pulls in native modules at import time; none are needed here.
jest.mock('../scan/ort', () => ({ InferenceSession: class {}, Tensor: class {} }));
jest.mock('../scan/models', () => ({ CORNELIUS: {}, MILO: {}, createSession: jest.fn() }));
jest.mock('../scan/capture', () => ({ loadFrame: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const db = require('../data/db') as { printingsMatchingSerials: jest.Mock; printingsForIndexRow: jest.Mock };

function printing(id: string, setCode: string, variant: Printing['variant'] = 'normal', name = 'Scratchmen Apoo'): Printing {
  return {
    id,
    cardId: 'onepiece:scratchmen-apoo',
    gameId: 'onepiece',
    name,
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

const standard = printing('onepiece:OP17:OP17070:normal:en', 'OP17');
const altArt = printing('onepiece:OP17:OP17070:alt:en', 'OP17', 'normal');

/** A pipeline that "sees" a card and produces a fixed embedding, with a 2-dim index. */
function fakePipeline(index: IndexPack | null): ScanPipeline {
  const pipeline = new ScanPipeline();
  pipeline.setIndex(index);
  const crop = { data: new Uint8Array(4), width: 1, height: 1 };
  pipeline.processFrame = jest.fn().mockResolvedValue({
    detection: { corners: [[0, 0], [1, 0], [1, 1], [0, 1]], sharpness: 0.06, confidence: 0.06, cardPresent: true },
    crop,
    embedding: Float32Array.from([1, 0]),
    candidates: [{ artId: 'onepiece:OPPR:OP16032:normal:en', score: 0.2, row: 0 }],
    rejected: null,
    timings: {},
  });
  return pipeline;
}

const frame = { data: new Uint8Array(16), width: 2, height: 2 };
const index: IndexPack = {
  ids: [standard.id, altArt.id],
  matrix: Float32Array.from([0.3, 0.95, 0.99, 0.1]), // the alt art is the closer picture
  dim: 2,
  version: 't',
};

beforeEach(() => {
  db.printingsMatchingSerials.mockReset();
  db.printingsForIndexRow.mockReset();
  // The picture match alone finds an unrelated card, as it did on device.
  db.printingsForIndexRow.mockResolvedValue({ artId: 'other-art', printings: [printing('other', 'OPPR', 'normal', 'Wrong Card')] });
});

it('lets a readable serial pick the card, and the picture choose the variant', async () => {
  db.printingsMatchingSerials.mockResolvedValue([standard, altArt]);
  const reader: SerialReader = jest.fn().mockResolvedValue({ serial: 'OP17-070', lines: ['Scratchmen Apoo', 'OP17-070 C'] });
  const service = new ScanService({ gameId: 'onepiece', serialReader: reader }, fakePipeline(index));

  const { result } = await service.scanImageOnce(frame);

  expect(reader).toHaveBeenCalledWith('onepiece', frame, expect.any(Array));
  expect(db.printingsMatchingSerials).toHaveBeenCalledWith('onepiece', expect.arrayContaining(['OP17-070', 'OP_7-070']));
  expect(result?.printing?.id).toBe(altArt.id); // its picture matches best
  expect(result?.candidates[0].printings.map((p) => p.id)).toEqual([altArt.id, standard.id]);
  expect(result?.parsedCorner?.number).toBe('OP17-070');
  expect(result?.confidence.tier).toBe('high');
  expect(result?.confidence.reasons.join(' ')).toContain('OP17-070');
  // The unrelated picture-only candidate is kept as an alternative, not the answer.
  expect(result?.candidates.some((candidate) => candidate.printings.some((p) => p.name === 'Wrong Card'))).toBe(true);
});

it('is one confident answer when only one printing carries the serial', async () => {
  db.printingsMatchingSerials.mockResolvedValue([standard]);
  const service = new ScanService({ gameId: 'onepiece', serialReader: async () => ({ serial: 'OP17-070', lines: ['Scratchmen Apoo'] }) }, fakePipeline(index));

  const { result } = await service.scanImageOnce(frame);

  expect(result?.printing?.id).toBe(standard.id);
  expect(result?.confidence.tier).toBe('high');
});

it('falls back to the picture match when no serial can be read', async () => {
  const service = new ScanService({ gameId: 'onepiece', serialReader: async () => null }, fakePipeline(index));

  const { result } = await service.scanImageOnce(frame);

  expect(db.printingsMatchingSerials).not.toHaveBeenCalled();
  expect(result?.printing?.name).toBe('Wrong Card');
});

it('falls back to the picture match when the serial is not in the catalogue', async () => {
  db.printingsMatchingSerials.mockResolvedValue([]);
  const service = new ScanService({ gameId: 'onepiece', serialReader: async () => ({ serial: 'OP99-001', lines: [] }) }, fakePipeline(index));

  const { result } = await service.scanImageOnce(frame);

  expect(result?.printing?.name).toBe('Wrong Card');
});

it('survives the reader failing, and does not read serials for games that have none', async () => {
  const failing = new ScanService(
    { gameId: 'onepiece', serialReader: async () => { throw new Error('ocr broke'); } },
    fakePipeline(index),
  );
  expect((await failing.scanImageOnce(frame)).result?.printing?.name).toBe('Wrong Card');

  const reader = jest.fn().mockResolvedValue({ serial: 'OP17-070', lines: [] });
  const pokemon = new ScanService({ gameId: 'pokemon', serialReader: reader }, fakePipeline(index));
  await pokemon.scanImageOnce(frame);
  expect(reader).not.toHaveBeenCalled();
});

describe('a serial misread by a digit', () => {
  // The bug seen on a real phone: "OP17-070" was read as "OP12-070", which is a
  // genuine serial of a different card, so it matched with full confidence.
  const wrongCard = printing('onepiece:OP12:OP12070:normal:en', 'OP12', 'normal', 'Some Other Character');
  wrongCard.number = 'OP12-070';
  standard.number = 'OP17-070';
  altArt.number = 'OP17-070';

  it('lets the printed name overrule the misread digit', async () => {
    db.printingsMatchingSerials.mockResolvedValue([wrongCard, standard, altArt]);
    const service = new ScanService(
      {
        gameId: 'onepiece',
        serialReader: async () => ({
          serial: 'OP12-070',
          lines: ['Scratchmen Apoo', 'On-Air Pirates/Animal Kingdom Pirtes OP12070 ER'],
        }),
      },
      fakePipeline(index),
    );

    const { result } = await service.scanImageOnce(frame);

    expect(result?.printing?.name).toBe('Scratchmen Apoo');
    expect(result?.printing?.number).toBe('OP17-070');
    expect(result?.parsedCorner?.number).toBe('OP17-070');
    expect(result?.confidence.tier).toBe('high');
    expect(result?.confidence.reasons.join(' ')).toContain('read as OP12-070');
  });

  it('only asks for a check when the name is just partly read', async () => {
    db.printingsMatchingSerials.mockResolvedValue([wrongCard, standard, altArt]);
    const service = new ScanService(
      { gameId: 'onepiece', serialReader: async () => ({ serial: 'OP12-070', lines: ['men Apoo', 'n'] }) },
      fakePipeline(index),
    );

    const { result } = await service.scanImageOnce(frame);

    expect(result?.printing?.number).toBe('OP17-070');
    expect(result?.confidence.tier).toBe('check');
  });

  it('keeps the serial as read when nothing contradicts it, but does not call it certain', async () => {
    db.printingsMatchingSerials.mockResolvedValue([wrongCard]);
    const service = new ScanService(
      { gameId: 'onepiece', serialReader: async () => ({ serial: 'OP12-070', lines: ['OP12-070'] }) },
      fakePipeline(null),
    );

    const { result } = await service.scanImageOnce(frame);

    expect(result?.printing?.number).toBe('OP12-070');
    // One printing has it, but neither the name nor the picture confirms the read.
    expect(result?.confidence.tier).toBe('check');
    expect(result?.confidence.reasons.join(' ')).toContain('not yet confirmed');
  });

  it('is high when the name confirms the serial exactly as read', async () => {
    db.printingsMatchingSerials.mockResolvedValue([standard]);
    const service = new ScanService(
      { gameId: 'onepiece', serialReader: async () => ({ serial: 'OP17-070', lines: ['Scratchmen Apoo', 'OP17-070'] }) },
      fakePipeline(null),
    );

    const { result } = await service.scanImageOnce(frame);

    expect(result?.printing?.id).toBe(standard.id);
    expect(result?.confidence.tier).toBe('high');
    expect(result?.confidence.reasons.join(' ')).toContain('card name agrees');
  });
});
