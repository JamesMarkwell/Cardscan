import { IndexPack, l2Normalise, search, voteAcrossFrames } from '../scan/search';

function pack(rows: number[][], ids: string[]): IndexPack {
  const dim = rows[0].length;
  const matrix = new Float32Array(rows.length * dim);
  rows.forEach((row, index) => {
    const normalised = l2Normalise(Float32Array.from(row));
    matrix.set(normalised, index * dim);
  });
  return { matrix, ids, dim, version: 'test' };
}

describe('search', () => {
  const index = pack(
    [
      [1, 0, 0],
      [0, 1, 0],
      [0.9, 0.1, 0],
      [0, 0, 1],
    ],
    ['a', 'b', 'c', 'd'],
  );

  it('ranks the nearest rows first', () => {
    const results = search(index, l2Normalise(Float32Array.from([1, 0, 0])), 3);
    expect(results.map((result) => result.artId)).toEqual(['a', 'c', 'b']);
    expect(results[0].score).toBeCloseTo(1, 5);
  });

  it('returns at most k results', () => {
    expect(search(index, l2Normalise(Float32Array.from([1, 0, 0])), 2)).toHaveLength(2);
  });

  it('returns nothing when the query has the wrong dimension', () => {
    expect(search(index, Float32Array.from([1, 0]), 3)).toEqual([]);
  });

  it('handles an empty index', () => {
    expect(search({ matrix: new Float32Array(0), ids: [], dim: 3, version: 'x' }, Float32Array.from([1, 0, 0]))).toEqual([]);
  });
});

describe('voteAcrossFrames', () => {
  it('prefers the card that wins consistently over a single lucky frame', () => {
    const voted = voteAcrossFrames([
      [
        { artId: 'steady', score: 0.7, row: 0 },
        { artId: 'lucky', score: 0.2, row: 1 },
      ],
      [
        { artId: 'steady', score: 0.72, row: 0 },
        { artId: 'lucky', score: 0.1, row: 1 },
      ],
      [{ artId: 'lucky', score: 0.95, row: 1 }],
    ]);

    expect(voted[0].artId).toBe('steady');
  });

  it('averages by frame count so scores stay comparable', () => {
    const voted = voteAcrossFrames([
      [{ artId: 'a', score: 0.8, row: 0 }],
      [{ artId: 'a', score: 0.6, row: 0 }],
    ]);
    expect(voted[0].score).toBeCloseTo(0.7, 6);
  });

  it('copes with no frames at all', () => {
    expect(voteAcrossFrames([])).toEqual([]);
  });
});

describe('l2Normalise', () => {
  it('leaves an all-zero vector alone instead of producing NaN', () => {
    expect(Array.from(l2Normalise(Float32Array.from([0, 0, 0])))).toEqual([0, 0, 0]);
  });
});
