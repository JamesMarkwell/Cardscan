/**
 * Confidence tiers.
 *
 * TCGplayer's scanner is trusted largely because it admits when it is probably
 * wrong. We do the same: combine the top-1 similarity, the gap to the runner
 * up, whether the OCR'd set/number agreed, and how many frames voted the same
 * way, then bucket into three tiers the UI can act on.
 */
import { Candidate } from './search';

export type ConfidenceTier = 'high' | 'check' | 'low';

export interface ConfidenceInput {
  candidates: Candidate[];
  /** Frames that contributed to the vote. */
  frameCount: number;
  /** true/false when OCR produced a usable set code or number, null when not attempted. */
  ocrAgrees: boolean | null;
  /** Detector sharpness head, 0..1. */
  sharpness: number | null;
}

export interface ConfidenceResult {
  tier: ConfidenceTier;
  score: number;
  topScore: number;
  gap: number;
  reasons: string[];
}

export const HIGH_THRESHOLD = 0.78;
export const CHECK_THRESHOLD = 0.6;

export function assessConfidence(input: ConfidenceInput): ConfidenceResult {
  const { candidates, frameCount, ocrAgrees, sharpness } = input;
  const reasons: string[] = [];

  if (candidates.length === 0) {
    return { tier: 'low', score: 0, topScore: 0, gap: 0, reasons: ['no candidates'] };
  }

  const topScore = candidates[0].score;
  const gap = candidates.length > 1 ? topScore - candidates[1].score : topScore;

  // Similarity carries most of the weight; the rest are corroboration.
  let score = 0.6 * topScore + 0.25 * Math.min(1, gap * 8);

  if (ocrAgrees === true) {
    score += 0.1;
    reasons.push('set/number matched');
  } else if (ocrAgrees === false) {
    score -= 0.15;
    reasons.push('set/number disagreed');
  }

  if (frameCount >= 3) {
    score += 0.05;
    reasons.push(`${frameCount} frames agreed`);
  }

  if (sharpness !== null && sharpness < 0.35) {
    score -= 0.1;
    reasons.push('blurry frame');
  }

  score = Math.max(0, Math.min(1, score));

  let tier: ConfidenceTier = 'low';
  if (score >= HIGH_THRESHOLD) tier = 'high';
  else if (score >= CHECK_THRESHOLD) tier = 'check';

  if (topScore < 0.5) {
    tier = 'low';
    reasons.push('weak match');
  }

  return { tier, score, topScore, gap, reasons };
}
