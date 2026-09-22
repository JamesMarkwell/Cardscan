import {
  applyHomography,
  computeHomography,
  isUsableQuad,
  orderCorners,
  quadArea,
  sampleBilinear,
  Point,
} from '../scan/geometry';

describe('orderCorners', () => {
  it('puts the top-left corner first and goes clockwise', () => {
    const shuffled: Point[] = [
      [0.8, 0.9],
      [0.2, 0.1],
      [0.8, 0.1],
      [0.2, 0.9],
    ];
    expect(orderCorners(shuffled)).toEqual([
      [0.2, 0.1],
      [0.8, 0.1],
      [0.8, 0.9],
      [0.2, 0.9],
    ]);
  });

  it('rotates a landscape quad so the short edge is the top edge', () => {
    // Wide quad in a square frame: the short edges are the left and right ones,
    // so ordering must rotate the card upright.
    const corners: Point[] = [
      [0.1, 0.4],
      [0.9, 0.4],
      [0.9, 0.6],
      [0.1, 0.6],
    ];
    const ordered = orderCorners(corners, 1000, 1000);
    const topEdge = Math.hypot(ordered[1][0] - ordered[0][0], ordered[1][1] - ordered[0][1]);
    const sideEdge = Math.hypot(ordered[2][0] - ordered[1][0], ordered[2][1] - ordered[1][1]);
    expect(topEdge).toBeLessThan(sideEdge);
  });
});

describe('isUsableQuad', () => {
  const square: Point[] = [
    [0.1, 0.1],
    [0.9, 0.1],
    [0.9, 0.9],
    [0.1, 0.9],
  ];

  it('accepts a convex quad', () => {
    expect(isUsableQuad(square)).toBe(true);
  });

  it('rejects a tiny quad', () => {
    expect(
      isUsableQuad([
        [0.5, 0.5],
        [0.52, 0.5],
        [0.52, 0.52],
        [0.5, 0.52],
      ]),
    ).toBe(false);
  });

  it('rejects a concave quad, which is what a missed corner looks like', () => {
    expect(
      isUsableQuad([
        [0.1, 0.1],
        [0.9, 0.1],
        [0.4, 0.35],
        [0.1, 0.9],
      ]),
    ).toBe(false);
  });

  it('rejects the wrong number of points', () => {
    expect(isUsableQuad(square.slice(0, 3))).toBe(false);
    expect(isUsableQuad(null)).toBe(false);
  });
});

describe('computeHomography', () => {
  it('maps the source quad exactly onto the destination quad', () => {
    const source: Point[] = [
      [12, 20],
      [180, 40],
      [170, 260],
      [20, 240],
    ];
    const destination: Point[] = [
      [0, 0],
      [447, 0],
      [447, 447],
      [0, 447],
    ];
    const matrix = computeHomography(source, destination);

    source.forEach((point, index) => {
      const [x, y] = applyHomography(matrix, point[0], point[1]);
      expect(x).toBeCloseTo(destination[index][0], 4);
      expect(y).toBeCloseTo(destination[index][1], 4);
    });
  });

  it('refuses a degenerate quad', () => {
    const degenerate: Point[] = [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    expect(() => computeHomography(degenerate, degenerate)).toThrow(/dewarp/i);
  });
});

describe('sampleBilinear', () => {
  it('interpolates between neighbouring pixels', () => {
    // 2x1 image: black then white, in the red channel.
    const data = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]);
    expect(sampleBilinear(data, 2, 1, 0, 0, 0)).toBe(0);
    expect(sampleBilinear(data, 2, 1, 1, 0, 0)).toBe(255);
    expect(sampleBilinear(data, 2, 1, 0.5, 0, 0)).toBeCloseTo(127.5, 5);
  });

  it('clamps outside the image rather than reading past the buffer', () => {
    const data = new Uint8Array([10, 0, 0, 255, 20, 0, 0, 255]);
    expect(sampleBilinear(data, 2, 1, -5, -5, 0)).toBe(10);
    expect(sampleBilinear(data, 2, 1, 99, 99, 0)).toBe(20);
  });
});

describe('quadArea', () => {
  it('measures the unit square', () => {
    expect(
      quadArea([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]),
    ).toBeCloseTo(1, 6);
  });
});
