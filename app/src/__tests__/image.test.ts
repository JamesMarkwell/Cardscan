import { cropNormalised, dewarp, dewarpRegion, laplacianVariance, rotate180, rotate90, squashResize, toImageNetTensor, IMAGENET_MEAN, IMAGENET_STD, RgbaImage } from '../scan/image';
import { Point } from '../scan/geometry';

function solid(width: number, height: number, rgb: [number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

function gradient(width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = Math.round((x / (width - 1)) * 255);
      data[offset + 1] = Math.round((y / (height - 1)) * 255);
      data[offset + 2] = 128;
      data[offset + 3] = 255;
    }
  }
  return { data, width, height };
}

describe('squashResize', () => {
  it('produces a square of the requested size', () => {
    const resized = squashResize(gradient(40, 20), 16);
    expect(resized.width).toBe(16);
    expect(resized.height).toBe(16);
    expect(resized.data).toHaveLength(16 * 16 * 4);
  });

  it('keeps a solid colour solid', () => {
    const resized = squashResize(solid(30, 10, [12, 34, 56]), 8);
    expect(Array.from(resized.data.slice(0, 4))).toEqual([12, 34, 56, 255]);
  });
});

describe('dewarp', () => {
  it('maps the full frame onto the crop when the quad is the whole frame', () => {
    const source = gradient(32, 32);
    const corners: Point[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const crop = dewarp(source, corners, 16);
    expect(crop.width).toBe(16);
    // Top-left stays dark in the red channel, top-right stays bright.
    expect(crop.data[0]).toBeLessThan(40);
    expect(crop.data[15 * 4]).toBeGreaterThan(200);
  });
});

describe('rotate180', () => {
  it('is its own inverse', () => {
    const original = gradient(8, 12);
    const roundTrip = rotate180(rotate180(original));
    expect(Array.from(roundTrip.data)).toEqual(Array.from(original.data));
  });

  it('moves the first pixel to the last', () => {
    const original = gradient(4, 4);
    const rotated = rotate180(original);
    const last = (4 * 4 - 1) * 4;
    expect(rotated.data[last]).toBe(original.data[0]);
  });
});

describe('toImageNetTensor', () => {
  it('lays the channels out planar and normalises them', () => {
    const tensor = toImageNetTensor(solid(2, 2, [255, 0, 0]), 2);
    expect(tensor).toHaveLength(3 * 2 * 2);
    expect(tensor[0]).toBeCloseTo((1 - IMAGENET_MEAN[0]) / IMAGENET_STD[0], 5);
    expect(tensor[4]).toBeCloseTo((0 - IMAGENET_MEAN[1]) / IMAGENET_STD[1], 5);
    expect(tensor[8]).toBeCloseTo((0 - IMAGENET_MEAN[2]) / IMAGENET_STD[2], 5);
  });

  it('reuses the buffer it is given', () => {
    const buffer = new Float32Array(3 * 2 * 2);
    expect(toImageNetTensor(solid(2, 2, [0, 0, 0]), 2, buffer)).toBe(buffer);
  });
});

describe('cropNormalised', () => {
  it('takes the requested region', () => {
    const crop = cropNormalised(gradient(20, 20), 0, 0.5, 1, 0.5);
    expect(crop.width).toBe(20);
    expect(crop.height).toBe(10);
  });

  it('clamps a region that runs off the edge', () => {
    const crop = cropNormalised(gradient(20, 20), 0.9, 0.9, 0.5, 0.5);
    expect(crop.width).toBeLessThanOrEqual(2);
    expect(crop.height).toBeLessThanOrEqual(2);
  });
});

describe('laplacianVariance', () => {
  it('is near zero for a flat image and larger for a noisy one', () => {
    const flat = laplacianVariance(solid(16, 16, [120, 120, 120]));
    const noisy = gradient(16, 16);
    for (let i = 0; i < noisy.data.length; i += 4) {
      noisy.data[i + 1] = i % 8 === 0 ? 0 : 255;
    }
    expect(flat).toBeCloseTo(0, 6);
    expect(laplacianVariance(noisy)).toBeGreaterThan(flat);
  });

  it('returns zero for an image too small to have a neighbourhood', () => {
    expect(laplacianVariance(solid(2, 2, [1, 2, 3]))).toBe(0);
  });
});

describe('rotate90', () => {
  /** 3 wide x 2 tall, each pixel's red channel is a distinct id 0..5 (row-major). */
  function labelled(): RgbaImage {
    const data = new Uint8Array(3 * 2 * 4);
    for (let i = 0; i < 6; i += 1) data.set([i, 0, 0, 255], i * 4);
    return { data, width: 3, height: 2 };
  }
  const ids = (image: RgbaImage) => Array.from({ length: image.width * image.height }, (_, i) => image.data[i * 4]);

  it('turns a 3x2 image clockwise into 2x3', () => {
    // 0 1 2      3 0
    // 3 4 5  ->  4 1
    //            5 2
    const rotated = rotate90(labelled(), true);
    expect([rotated.width, rotated.height]).toEqual([2, 3]);
    expect(ids(rotated)).toEqual([3, 0, 4, 1, 5, 2]);
  });

  it('turns it counter-clockwise the other way', () => {
    // 0 1 2      2 5
    // 3 4 5  ->  1 4
    //            0 3
    const rotated = rotate90(labelled(), false);
    expect([rotated.width, rotated.height]).toEqual([2, 3]);
    expect(ids(rotated)).toEqual([2, 5, 1, 4, 0, 3]);
  });

  it('undoes itself, and two quarter turns equal rotate180', () => {
    const image = labelled();
    expect(ids(rotate90(rotate90(image, true), false))).toEqual(ids(image));
    expect(ids(rotate90(rotate90(image, true), true))).toEqual(ids(rotate180(image)));
  });
});

describe('dewarpRegion', () => {
  /** 40x40 frame: the top half is red, the bottom half blue, left third green. */
  function frame(): RgbaImage {
    const width = 40;
    const height = 40;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const o = (y * width + x) * 4;
        const rgb = x < 13 ? [0, 255, 0] : y < 20 ? [255, 0, 0] : [0, 0, 255];
        data.set([rgb[0], rgb[1], rgb[2], 255], o);
      }
    }
    return { data, width, height };
  }
  const upright: Point[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const pixel = (image: RgbaImage, x: number, y: number) => Array.from(image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3));

  it('returns the requested size and samples the requested part of the card', () => {
    // Bottom-right of the card is blue; top-right is red.
    const bottomRight = dewarpRegion(frame(), upright, { left: 0.6, top: 0.6, width: 0.4, height: 0.4 }, 8, 6);
    expect([bottomRight.width, bottomRight.height]).toEqual([8, 6]);
    expect(pixel(bottomRight, 4, 3)).toEqual([0, 0, 255]);

    const topRight = dewarpRegion(frame(), upright, { left: 0.6, top: 0.0, width: 0.4, height: 0.4 }, 8, 6);
    expect(pixel(topRight, 4, 3)).toEqual([255, 0, 0]);
  });

  it('follows the corners: a card turned half a turn has its bottom-right where the frame’s top-left is', () => {
    // Corners listed TL,TR,BR,BL of a card that sits upside down in the frame.
    const upsideDown: Point[] = [[1, 1], [0, 1], [0, 0], [1, 0]];
    // The card's bottom-right corner is the frame's top-left: green there.
    const region = dewarpRegion(frame(), upsideDown, { left: 0.85, top: 0.85, width: 0.15, height: 0.15 }, 4, 4);
    expect(pixel(region, 2, 2)).toEqual([0, 255, 0]);
  });

  it('reads a wide strip at the card’s own proportions from a skewed quad', () => {
    const skewed: Point[] = [[0.1, 0.05], [0.95, 0.1], [0.9, 0.95], [0.05, 0.9]];
    const strip = dewarpRegion(frame(), skewed, { left: 0.45, top: 0.86, width: 0.55, height: 0.14 }, 64, 23);
    expect(strip.data).toHaveLength(64 * 23 * 4);
  });
});
