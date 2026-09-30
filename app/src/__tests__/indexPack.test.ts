/**
 * The packs are written by Python (/ml/index_pack.py) and read by TypeScript,
 * so these fixtures are real files produced by the writer — a format drift on
 * either side fails here rather than on a phone.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  assertPackMatchesIds,
  float16ToFloat32,
  isIndexStale,
  packRowCount,
  parseIndexPack,
  remoteIndexEtag,
  withVersionParam,
} from '../data/indexPackFormat';
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


describe('keeping the phone\u2019s pack current', () => {
  describe('isIndexStale', () => {
    it('is stale when the server\u2019s copy has a different ETag', () => {
      expect(isIndexStale('"aaa"', '"bbb"')).toBe(true);
    });

    it('is current when the ETags match', () => {
      expect(isIndexStale('"aaa"', '"aaa"')).toBe(false);
    });

    it('is stale when no ETag was recorded — a pack from before they were kept is fetched once more', () => {
      expect(isIndexStale(null, '"aaa"')).toBe(true);
    });

    it('keeps what it has when the server gives no answer', () => {
      expect(isIndexStale('"aaa"', null)).toBe(false);
      expect(isIndexStale(null, null)).toBe(false);
    });
  });

  describe('remoteIndexEtag', () => {
    it('asks with HEAD and returns the ETag', async () => {
      const fetchFn = jest.fn().mockResolvedValue(new Response(null, { status: 200, headers: { etag: '"abc"' } }));
      expect(await remoteIndexEtag('https://w/packs/games/onepiece/index-1.bin', fetchFn)).toBe('"abc"');
      expect(fetchFn).toHaveBeenCalledWith('https://w/packs/games/onepiece/index-1.bin', { method: 'HEAD' });
    });

    it('returns null for an error response, or one with no ETag', async () => {
      expect(await remoteIndexEtag('u', jest.fn().mockResolvedValue(new Response(null, { status: 404 })))).toBeNull();
      expect(await remoteIndexEtag('u', jest.fn().mockResolvedValue(new Response(null, { status: 200 })))).toBeNull();
    });
  });

  describe('withVersionParam', () => {
    it('makes a changed pack a different URL', () => {
      expect(withVersionParam('https://w/p.bin', '"abc"')).toBe('https://w/p.bin?e=%22abc%22');
      expect(withVersionParam('https://w/p.bin?x=1', '"abc"')).toBe('https://w/p.bin?x=1&e=%22abc%22');
    });

    it('leaves the URL alone with no ETag', () => {
      expect(withVersionParam('https://w/p.bin', null)).toBe('https://w/p.bin');
    });
  });

  describe('assertPackMatchesIds', () => {
    it('accepts a pack and the ids written with it', () => {
      const { buffer, ids } = load('sample-f32');
      expect(packRowCount(new Uint8Array(buffer))).toBe(ids.length);
      expect(() => assertPackMatchesIds(new Uint8Array(buffer), ids.join('\n'))).not.toThrow();
    });

    it('ignores blank lines and a trailing newline', () => {
      const { buffer, ids } = load('sample-f32');
      expect(() => assertPackMatchesIds(new Uint8Array(buffer), `${ids.join('\n')}\n\n`)).not.toThrow();
    });

    it('rejects a pack whose ids belong to a different build', () => {
      const { buffer, ids } = load('sample-f32');
      expect(() => assertPackMatchesIds(new Uint8Array(buffer), ids.slice(1).join('\n'))).toThrow(/rows but/);
    });

    it('rejects something that is not a pack, or a truncated one', () => {
      expect(() => assertPackMatchesIds(new Uint8Array(32), 'a')).toThrow(/Not a CardScan index pack/);
      expect(() => assertPackMatchesIds(new Uint8Array(4), 'a')).toThrow(/truncated/);
    });
  });
});
