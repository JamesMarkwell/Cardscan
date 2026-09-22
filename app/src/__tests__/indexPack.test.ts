/**
 * The packs are written by Python (/ml/index_pack.py) and read by TypeScript,
 * so these fixtures are real files produced by the writer — a format drift on
 * either side fails here rather than on a phone.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { float16ToFloat32, parseIndexPack } from '../data/indexPackFormat';
import { search } from '../scan/search';

const FIXTURES = join(__dirname, 'fixtures');

function load(name: string): { buffer: ArrayBuffer; ids: string[] } {
  const bytes = readFileSync(join(FIXTURES, `${name}.bin`));
  const ids = readFileSync(join(FIXTURES, `${name}.ids`), 'utf8').split('\n').filter(Boolean);
  return { buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, ids };
}

const expected = JSON.parse(readFileSync(join(FIXTURES, 'sample-expected.json'), 'utf8')) as {
  ids: string[];
  matrix: number[][];
};

describe('parseIndexPack', () => {
  it('reads a float32 pack written by the Python job', () => {
    const { buffer, ids } = load('sample-f32');
    const pack = parseIndexPack(buffer, ids, 'v1');

    expect(pack.ids).toEqual(expected.ids);
    expect(pack.dim).toBe(expected.matrix[0].length);
    expected.matrix.forEach((row, rowIndex) => {
      row.forEach((value, column) => {
        expect(pack.matrix[rowIndex * pack.dim + column]).toBeCloseTo(value, 5);
      });
    });
  });

  it('reads the float16 pack to within half-precision', () => {
    const { buffer, ids } = load('sample-f16');
    const pack = parseIndexPack(buffer, ids, 'v1');

    expected.matrix.forEach((row, rowIndex) => {
      row.forEach((value, column) => {
        expect(pack.matrix[rowIndex * pack.dim + column]).toBeCloseTo(value, 2);
      });
    });
  });

  it('finds a row when queried with that row, in both dtypes', () => {
    for (const name of ['sample-f32', 'sample-f16']) {
      const { buffer, ids } = load(name);
      const pack = parseIndexPack(buffer, ids, 'v1');
      const query = pack.matrix.slice(2 * pack.dim, 3 * pack.dim);

      const results = search(pack, query, 1);
      expect(results[0].artId).toBe(ids[2]);
      expect(results[0].score).toBeCloseTo(1, 2);
    }
  });

  it('rejects a buffer that is not a pack', () => {
    const notAPack = new ArrayBuffer(32);
    expect(() => parseIndexPack(notAPack, [], 'v1')).toThrow(/index pack/i);
  });

  it('rejects an id list that does not line up with the rows', () => {
    const { buffer } = load('sample-f32');
    expect(() => parseIndexPack(buffer, ['only-one'], 'v1')).toThrow(/rows/);
  });
});

describe('float16ToFloat32', () => {
  it('decodes the usual landmarks', () => {
    expect(float16ToFloat32(0x0000)).toBe(0);
    expect(float16ToFloat32(0x3c00)).toBe(1);
    expect(float16ToFloat32(0xbc00)).toBe(-1);
    expect(float16ToFloat32(0x3800)).toBeCloseTo(0.5, 6);
  });
});
