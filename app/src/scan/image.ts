/**
 * RGBA buffer helpers: squash-resize, perspective dewarp and the ImageNet
 * tensor packing both CollectorVision models expect.
 */
import { applyHomography, computeHomography, Point, sampleBilinear } from './geometry';

export const IMAGENET_MEAN = [0.485, 0.456, 0.406];
export const IMAGENET_STD = [0.229, 0.224, 0.225];

export const DETECTOR_SIZE = 384;
export const EMBEDDER_SIZE = 448;

export interface RgbaImage {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Resize by stretching to a square, the same "squash" the reference scanner
 * does when feeding the detector. Aspect ratio is deliberately not preserved:
 * the detector was trained on squashed input and returns coordinates in the
 * squashed space, which map back linearly.
 */
export function squashResize(image: RgbaImage, size: number): RgbaImage {
  const out = new Uint8Array(size * size * 4);
  const scaleX = image.width / size;
  const scaleY = image.height / size;

  for (let y = 0; y < size; y += 1) {
    const sy = (y + 0.5) * scaleY - 0.5;
    for (let x = 0; x < size; x += 1) {
      const sx = (x + 0.5) * scaleX - 0.5;
      const offset = (y * size + x) * 4;
      out[offset] = sampleBilinear(image.data, image.width, image.height, sx, sy, 0);
      out[offset + 1] = sampleBilinear(image.data, image.width, image.height, sx, sy, 1);
      out[offset + 2] = sampleBilinear(image.data, image.width, image.height, sx, sy, 2);
      out[offset + 3] = 255;
    }
  }

  return { data: out, width: size, height: size };
}

/**
 * Flatten the quad (normalised coordinates) to a square crop, like a document
 * scanner. The inverse homography is sampled per destination pixel.
 */
export function dewarp(image: RgbaImage, corners: Point[], size = EMBEDDER_SIZE): RgbaImage {
  const sourcePoints: Point[] = corners.map(([x, y]) => [x * image.width, y * image.height]);
  const targetPoints: Point[] = [
    [0, 0],
    [size - 1, 0],
    [size - 1, size - 1],
    [0, size - 1],
  ];

  // Map destination -> source so every output pixel gets a value.
  const inverse = computeHomography(targetPoints, sourcePoints);
  const out = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [sx, sy] = applyHomography(inverse, x, y);
      const offset = (y * size + x) * 4;
      out[offset] = sampleBilinear(image.data, image.width, image.height, sx, sy, 0);
      out[offset + 1] = sampleBilinear(image.data, image.width, image.height, sx, sy, 1);
      out[offset + 2] = sampleBilinear(image.data, image.width, image.height, sx, sy, 2);
      out[offset + 3] = 255;
    }
  }

  return { data: out, width: size, height: size };
}

/** Rotate an RGBA image 180 degrees, used for the upside-down retry. */
export function rotate180(image: RgbaImage): RgbaImage {
  const { width, height, data } = image;
  const out = new Uint8Array(width * height * 4);
  const total = width * height;

  for (let i = 0; i < total; i += 1) {
    const src = i * 4;
    const dst = (total - 1 - i) * 4;
    out[dst] = data[src];
    out[dst + 1] = data[src + 1];
    out[dst + 2] = data[src + 2];
    out[dst + 3] = data[src + 3];
  }

  return { data: out, width, height };
}

/** Pack an RGBA square into NCHW float32 with ImageNet normalisation. */
export function toImageNetTensor(image: RgbaImage, size: number, into?: Float32Array): Float32Array {
  const tensor = into ?? new Float32Array(3 * size * size);
  const plane = size * size;

  for (let i = 0; i < plane; i += 1) {
    const r = image.data[i * 4] / 255;
    const g = image.data[i * 4 + 1] / 255;
    const b = image.data[i * 4 + 2] / 255;
    tensor[i] = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    tensor[plane + i] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    tensor[plane * 2 + i] = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
  }

  return tensor;
}

/** Crop a normalised sub-rectangle out of an RGBA image. */
export function cropNormalised(
  image: RgbaImage,
  left: number,
  top: number,
  width: number,
  height: number,
): RgbaImage {
  const x0 = Math.max(0, Math.round(left * image.width));
  const y0 = Math.max(0, Math.round(top * image.height));
  const w = Math.max(1, Math.min(image.width - x0, Math.round(width * image.width)));
  const h = Math.max(1, Math.min(image.height - y0, Math.round(height * image.height)));
  const out = new Uint8Array(w * h * 4);

  for (let y = 0; y < h; y += 1) {
    const srcRow = (y0 + y) * image.width;
    for (let x = 0; x < w; x += 1) {
      const src = (srcRow + x0 + x) * 4;
      const dst = (y * w + x) * 4;
      out[dst] = image.data[src];
      out[dst + 1] = image.data[src + 1];
      out[dst + 2] = image.data[src + 2];
      out[dst + 3] = 255;
    }
  }

  return { data: out, width: w, height: h };
}

/**
 * Variance of a 4-neighbour Laplacian over the green channel — the standard
 * cheap "is this in focus?" measure. Higher is sharper.
 */
export function laplacianVariance(image: RgbaImage): number {
  const { width, height, data } = image;
  if (width < 3 || height < 3) return 0;

  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = (y * width + x) * 4 + 1;
      const value =
        4 * data[i] -
        data[i - 4] -
        data[i + 4] -
        data[i - width * 4] -
        data[i + width * 4];
      sum += value;
      sumSq += value * value;
      count += 1;
    }
  }

  const mean = sum / count;
  return sumSq / count - mean * mean;
}
