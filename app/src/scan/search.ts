/**
 * Brute-force cosine search over the fingerprint index.
 *
 * Both the query and the stored rows are L2-normalised, so cosine similarity is
 * a plain dot product. 200k rows x 128 dims is about 25M multiply-adds, which
 * is a few tens of milliseconds on a phone — no vector database needed.
 */

export interface IndexPack {
  /** Row-major (rows x dim) matrix of L2-normalised embeddings. */
  matrix: Float32Array;
  /** artId for each row, aligned by index. */
  ids: string[];
  dim: number;
  version: string;
}

export interface Candidate {
  artId: string;
  score: number;
  row: number;
}

export function rowCount(pack: IndexPack): number {
  return pack.dim > 0 ? Math.floor(pack.matrix.length / pack.dim) : 0;
}

export function l2Normalise(vector: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vector.length; i += 1) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm;
  return out;
}

/** Top-k nearest rows by cosine similarity. */
export function search(pack: IndexPack, query: Float32Array, k = 10): Candidate[] {
  const { matrix, dim, ids } = pack;
  const rows = rowCount(pack);
  if (rows === 0 || query.length !== dim) return [];

  // Small bounded insertion list — cheaper than sorting every row.
  const best: Candidate[] = [];
  let worst = -Infinity;

  for (let row = 0; row < rows; row += 1) {
    const base = row * dim;
    let score = 0;
    for (let d = 0; d < dim; d += 1) score += matrix[base + d] * query[d];

    if (best.length < k || score > worst) {
      const entry: Candidate = { artId: ids[row], score, row };
      let insertAt = best.length;
      while (insertAt > 0 && best[insertAt - 1].score < score) insertAt -= 1;
      best.splice(insertAt, 0, entry);
      if (best.length > k) best.pop();
      worst = best[best.length - 1].score;
    }
  }

  return best;
}

/**
 * Multi-frame voting: sum each candidate's score across the recent frames and
 * re-rank. A card that wins consistently beats one that wins a single lucky
 * frame, which is what the confidence tiers rely on.
 */
export function voteAcrossFrames(frames: Candidate[][], k = 10): Candidate[] {
  const totals = new Map<string, { score: number; row: number }>();

  for (const frame of frames) {
    for (const candidate of frame) {
      const existing = totals.get(candidate.artId);
      if (existing) existing.score += candidate.score;
      else totals.set(candidate.artId, { score: candidate.score, row: candidate.row });
    }
  }

  const frameCount = Math.max(1, frames.length);
  return [...totals.entries()]
    .map(([artId, value]) => ({ artId, score: value.score / frameCount, row: value.row }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
