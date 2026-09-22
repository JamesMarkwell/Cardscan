/**
 * Quad ordering, homography and sampling helpers.
 *
 * Ported from CollectorVision's reference web scanner
 * (examples/web_scanner/scanner.worker.mjs, AGPL-3.0) so that this app's
 * dewarp is numerically the same as the one the models were validated with.
 * See docs/THIRD_PARTY.md.
 */

export type Point = [number, number];

/** 3x3 homography, row major. */
export type Homography = number[];

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Rotate the quad so the shortest edge comes first. Cards are taller than they
 * are wide, so the shortest edge is the top edge — this is what stops the
 * dewarped crop coming out sideways.
 */
export function orientShortestEdgeTop(corners: Point[], width: number, height: number): Point[] {
  const edgeLengths = corners.map(([x1, y1], index) => {
    const [x2, y2] = corners[(index + 1) % corners.length];
    const dx = (x1 - x2) * width;
    const dy = (y1 - y2) * height;
    return Math.hypot(dx, dy);
  });
  let shortestEdge = 0;
  for (let i = 1; i < edgeLengths.length; i += 1) {
    if (edgeLengths[i] < edgeLengths[shortestEdge]) shortestEdge = i;
  }
  return corners.map((_, index) => corners[(index + shortestEdge) % corners.length]);
}

/** Order four points clockwise starting from the top-left-most one. */
export function orderCorners(points: Point[], width: number | null = null, height: number | null = null): Point[] {
  const cx = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const cy = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  const sorted = [...points].sort(
    ([ax, ay], [bx, by]) => Math.atan2(ay - cy, ax - cx) - Math.atan2(by - cy, bx - cx),
  );

  let start = 0;
  let best = Infinity;
  for (let i = 0; i < sorted.length; i += 1) {
    const score = sorted[i][0] + sorted[i][1];
    if (score < best) {
      best = score;
      start = i;
    }
  }

  const ordered: Point[] = [
    sorted[start],
    sorted[(start + 1) % 4],
    sorted[(start + 2) % 4],
    sorted[(start + 3) % 4],
  ];

  const signedArea = ordered.reduce((sum, [x1, y1], i) => {
    const [x2, y2] = ordered[(i + 1) % ordered.length];
    return sum + (x1 * y2 - x2 * y1);
  }, 0);
  const canonical = signedArea < 0 ? [ordered[0], ordered[3], ordered[2], ordered[1]] : ordered;

  return width && height ? orientShortestEdgeTop(canonical, width, height) : canonical;
}

export function quadArea(corners: Point[]): number {
  let area = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const [x1, y1] = corners[i];
    const [x2, y2] = corners[(i + 1) % corners.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) * 0.5;
}

/**
 * Reject degenerate quads: tiny, duplicated corners, or concave. A concave quad
 * usually means the detector missed a corner that was outside the frame.
 */
export function isUsableQuad(corners: Point[] | null | undefined): boolean {
  if (!corners || corners.length !== 4) return false;

  const area = quadArea(corners);
  if (!Number.isFinite(area) || area < 0.01) return false;

  for (let i = 0; i < corners.length; i += 1) {
    for (let j = i + 1; j < corners.length; j += 1) {
      const dx = corners[i][0] - corners[j][0];
      const dy = corners[i][1] - corners[j][1];
      if (dx * dx + dy * dy < 0.0004) return false;
    }
  }

  let pos = 0;
  let neg = 0;
  for (let i = 0; i < 4; i += 1) {
    const prev = corners[(i + 3) % 4];
    const curr = corners[i];
    const next = corners[(i + 1) % 4];
    const cross = (curr[0] - prev[0]) * (next[1] - curr[1]) - (curr[1] - prev[1]) * (next[0] - curr[0]);
    if (cross > 0) pos += 1;
    if (cross < 0) neg += 1;
  }
  return !(pos > 0 && neg > 0);
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] {
  const size = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index]]);

  for (let col = 0; col < size; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < size; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-10) throw new Error('Could not solve dewarp transform.');
    if (pivot !== col) {
      const tmp = a[col];
      a[col] = a[pivot];
      a[pivot] = tmp;
    }
    const scale = a[col][col];
    for (let k = col; k <= size; k += 1) a[col][k] /= scale;
    for (let row = 0; row < size; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let k = col; k <= size; k += 1) a[row][k] -= factor * a[col][k];
    }
  }

  return a.map((row) => row[size]);
}

/** Homography mapping srcPoints onto dstPoints (both length 4). */
export function computeHomography(srcPoints: Point[], dstPoints: Point[]): Homography {
  const matrix: number[][] = [];
  const vector: number[] = [];

  for (let i = 0; i < 4; i += 1) {
    const [sx, sy] = srcPoints[i];
    const [dx, dy] = dstPoints[i];
    matrix.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx]);
    vector.push(dx);
    matrix.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy]);
    vector.push(dy);
  }

  const solution = solveLinearSystem(matrix, vector);
  return [...solution, 1];
}

export function applyHomography(matrix: Homography, x: number, y: number): Point {
  const denom = matrix[6] * x + matrix[7] * y + matrix[8];
  return [
    (matrix[0] * x + matrix[1] * y + matrix[2]) / denom,
    (matrix[3] * x + matrix[4] * y + matrix[5]) / denom,
  ];
}

/** Bilinear sample of one channel out of an RGBA buffer. */
export function sampleBilinear(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  channel: number,
): number {
  const clampedX = Math.min(Math.max(x, 0), width - 1);
  const clampedY = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const tx = clampedX - x0;
  const ty = clampedY - y0;

  const i00 = (y0 * width + x0) * 4 + channel;
  const i10 = (y0 * width + x1) * 4 + channel;
  const i01 = (y1 * width + x0) * 4 + channel;
  const i11 = (y1 * width + x1) * 4 + channel;

  const top = data[i00] * (1 - tx) + data[i10] * tx;
  const bottom = data[i01] * (1 - tx) + data[i11] * tx;
  return top * (1 - ty) + bottom * ty;
}
