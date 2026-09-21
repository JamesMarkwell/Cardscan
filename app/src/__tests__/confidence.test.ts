import { assessConfidence } from '../scan/confidence';
import { Candidate } from '../scan/search';

const strong: Candidate[] = [
  { artId: 'a', score: 0.94, row: 0 },
  { artId: 'b', score: 0.61, row: 1 },
];

const ambiguous: Candidate[] = [
  { artId: 'a', score: 0.72, row: 0 },
  { artId: 'b', score: 0.71, row: 1 },
];

describe('assessConfidence', () => {
  it('calls a clear winner high confidence', () => {
    const result = assessConfidence({ candidates: strong, frameCount: 3, ocrAgrees: true, sharpness: 0.8 });
    expect(result.tier).toBe('high');
  });

  it('drops to low when two candidates are neck and neck, so the user picks', () => {
    const result = assessConfidence({ candidates: ambiguous, frameCount: 3, ocrAgrees: null, sharpness: 0.8 });
    expect(result.tier).toBe('low');
  });

  it('lands on check for a good-but-not-certain match', () => {
    const result = assessConfidence({
      candidates: [
        { artId: 'a', score: 0.86, row: 0 },
        { artId: 'b', score: 0.8, row: 1 },
      ],
      frameCount: 3,
      ocrAgrees: null,
      sharpness: 0.8,
    });
    expect(result.tier).toBe('check');
  });

  it('drops to low when the OCR disagrees with the chosen printing', () => {
    const agreeing = assessConfidence({ candidates: strong, frameCount: 3, ocrAgrees: true, sharpness: 0.9 });
    const disagreeing = assessConfidence({ candidates: strong, frameCount: 3, ocrAgrees: false, sharpness: 0.9 });
    expect(disagreeing.score).toBeLessThan(agreeing.score);
    expect(disagreeing.reasons).toContain('set/number disagreed');
  });

  it('never calls a weak top score anything but low', () => {
    const result = assessConfidence({
      candidates: [{ artId: 'a', score: 0.42, row: 0 }],
      frameCount: 5,
      ocrAgrees: true,
      sharpness: 1,
    });
    expect(result.tier).toBe('low');
  });

  it('reports low with no candidates rather than throwing', () => {
    const result = assessConfidence({ candidates: [], frameCount: 0, ocrAgrees: null, sharpness: null });
    expect(result.tier).toBe('low');
    expect(result.score).toBe(0);
  });

  it('penalises a blurry frame', () => {
    const sharp = assessConfidence({ candidates: strong, frameCount: 3, ocrAgrees: null, sharpness: 0.9 });
    const blurry = assessConfidence({ candidates: strong, frameCount: 3, ocrAgrees: null, sharpness: 0.1 });
    expect(blurry.score).toBeLessThan(sharp.score);
  });

  it('keeps the score inside 0..1', () => {
    const result = assessConfidence({
      candidates: [{ artId: 'a', score: 1, row: 0 }, { artId: 'b', score: 0, row: 1 }],
      frameCount: 9,
      ocrAgrees: true,
      sharpness: 1,
    });
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
