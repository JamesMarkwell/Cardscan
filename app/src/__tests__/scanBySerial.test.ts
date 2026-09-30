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
  printingsBySerial: jest.fn(),
  printingsForIndexRow: jest.fn(),
}));
// The pipeline pulls in native modules at import time; none are needed here.
jest.mock('../scan/ort', () => ({ InferenceSession: class {}, Tensor: class {} }));
jest.mock('../scan/models', () => ({ CORNELIUS: {}, MILO: {}, createSession: jest.fn() }));
jest.mock('../scan/capture', () => ({ loadFrame: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const db = require('../data/db') as { printingsBySerial: jest.Mock; printingsForIndexRow: jest.Mock };

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
  db.printingsBySerial.mockReset();
  db.printingsForIndexRow.mockReset();
  // The picture match alone finds an unrelated card, as it did on device.
  db.printingsForIndexRow.mockResolvedValue({ artId: 'other-art', printings: [printing('other', 'OPPR', 'normal', 'Wrong Card')] });
});

it('lets a readable serial pick the card, and the picture choose the variant', async () => {
  db.printingsBySerial.mockResolvedValue([standard, altArt]);
  const reader: SerialReader = jest.fn().mockResolvedValue('OP17-070');
  const service = new ScanService({ gameId: 'onepiece', serialReader: reader }, fakePipeline(index));

  const { result } = await service.scanImageOnce(frame);

  expect(reader).toHaveBeenCalledWith('onepiece', frame, expect.any(Array));
  expect(db.printingsBySerial).toHaveBeenCalledWith('onepiece', 'OP17-070');
  expect(result?.printing?.id).toBe(altArt.id); // its picture matches best
  expect(result?.candidates[0].printings.map((p) => p.id)).toEqual([altArt.id, standard.id]);
  expect(result?.parsedCorner?.number).toBe('OP17-070');
  expect(result?.confidence.tier).toBe('high');
  expect(result?.confidence.reasons.join(' ')).toContain('OP17-070');
  // The unrelated picture-only candidate is kept as an alternative, not the answer.
  expect(result?.candidates.some((candidate) => candidate.printings.some((p) => p.name === 'Wrong Card'))).toBe(true);
});

it('is one confident answer when only one printing carries the serial', async () => {
  db.printingsBySerial.mockResolvedValue([standard]);
  const service = new ScanService({ gameId: 'onepiece', serialReader: async () => 'OP17-070' }, fakePipeline(index));

  const { result } = await service.scanImageOnce(frame);

  expect(result?.printing?.id).toBe(standard.id);
  expect(result?.confidence.tier).toBe('high');
});

it('falls back to the picture match when no serial can be read', async () => {
  const service = new ScanService({ gameId: 'onepiece', serialReader: async () => null }, fakePipeline(index));

  const { result } = await service.scanImageOnce(frame);

  expect(db.printingsBySerial).not.toHaveBeenCalled();
  expect(result?.printing?.name).toBe('Wrong Card');
});

it('falls back to the picture match when the serial is not in the catalogue', async () => {
  db.printingsBySerial.mockResolvedValue([]);
  const service = new ScanService({ gameId: 'onepiece', serialReader: async () => 'OP99-001' }, fakePipeline(index));

  const { result } = await service.scanImageOnce(frame);

  expect(result?.printing?.name).toBe('Wrong Card');
});

it('survives the reader failing, and does not read serials for games that have none', async () => {
  const failing = new ScanService(
    { gameId: 'onepiece', serialReader: async () => { throw new Error('ocr broke'); } },
    fakePipeline(index),
  );
  expect((await failing.scanImageOnce(frame)).result?.printing?.name).toBe('Wrong Card');

  const reader = jest.fn().mockResolvedValue('OP17-070');
  const pokemon = new ScanService({ gameId: 'pokemon', serialReader: reader }, fakePipeline(index));
  await pokemon.scanImageOnce(frame);
  expect(reader).not.toHaveBeenCalled();
});
