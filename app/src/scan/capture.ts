/**
 * Turning a camera photo into the RGBA buffer the pipeline works on.
 *
 * The native resize does the heavy lifting: decoding a full-resolution photo in
 * JavaScript would be far too slow. Even the working buffer's JPEG decode and
 * pixel loops run synchronously on the JS thread, so its cost is what the camera
 * loop pays every frame — and while it runs, React Native can't service touches.
 * 540px keeps that decode/resize cost down (it scales with pixel count, so this
 * is ~40% cheaper than 720px) while still giving the 384px detector and the
 * dewarped 448px crop more than enough resolution.
 */
import { ImageManipulator, SaveFormat, manipulateAsync } from 'expo-image-manipulator';
import { decode as decodeJpeg } from 'jpeg-js';
import type { Image } from 'react-native-nitro-image';
import { base64ToBytes } from './base64';
import { RgbaImage } from './image';

/** Working width. TCGplayer's own guidance is that resolution past ~100 DPI adds nothing. */
export const WORKING_WIDTH = 540;

// Byte offsets of R, G, B within each source pixel, per native pixel format.
const CHANNEL_ORDER: Record<string, { r: number; g: number; b: number; n: number }> = {
  RGBA: { r: 0, g: 1, b: 2, n: 4 },
  RGBX: { r: 0, g: 1, b: 2, n: 4 },
  RGB: { r: 0, g: 1, b: 2, n: 3 },
  BGRA: { r: 2, g: 1, b: 0, n: 4 },
  BGRX: { r: 2, g: 1, b: 0, n: 4 },
  BGR: { r: 2, g: 1, b: 0, n: 3 },
  ARGB: { r: 1, g: 2, b: 3, n: 4 },
  XRGB: { r: 1, g: 2, b: 3, n: 4 },
  ABGR: { r: 3, g: 2, b: 1, n: 4 },
  XBGR: { r: 3, g: 2, b: 1, n: 4 },
};

/**
 * Downscale a captured native Image and read it out as an RGBA buffer.
 *
 * This is the live-capture path and stays entirely native until the very end:
 * `resizeAsync` shrinks the full-resolution photo to the working width on a
 * background thread, and `toRawPixelDataAsync` hands back the small buffer's raw
 * bytes — no JPEG decode on the JS thread (that is what hung/OOM-crashed the
 * app). The only JS work is repacking the small buffer into RGBA, honouring
 * whatever native pixel order the platform reports.
 */
export function imageToRgba(image: Image, width = WORKING_WIDTH): RgbaImage {
  const height = image.width > 0 ? Math.max(1, Math.round(width * (image.height / image.width))) : width;
  // Synchronous native ops: an async native image promise was never resolving on
  // this build, so avoid awaiting one here. Resizing first keeps this cheap.
  const small = image.resize(width, height);
  const raw = small.toRawPixelData();

  const src = new Uint8Array(raw.buffer);
  const w = raw.width;
  const h = raw.height;
  const order = CHANNEL_ORDER[raw.pixelFormat] ?? CHANNEL_ORDER.RGBA;
  const stride = Math.max(order.n * w, Math.floor(src.length / h));

  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const row = y * stride;
    const orow = y * w * 4;
    for (let x = 0; x < w; x += 1) {
      const s = row + x * order.n;
      const d = orow + x * 4;
      out[d] = src[s + order.r];
      out[d + 1] = src[s + order.g];
      out[d + 2] = src[s + order.b];
      out[d + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Load a photo file as an RGBA buffer, downscaled to the working width.
 *
 * The resize happens natively (fast) so jpeg-js only ever decodes a small ~540px
 * image; decoding a full-resolution capture in JS would take many seconds and
 * appear to hang. Uses the modern ImageManipulator API — the legacy
 * `manipulateAsync` never resolves on SDK 57.
 */
export async function loadFrame(uri: string, width = WORKING_WIDTH): Promise<RgbaImage> {
  const image = await ImageManipulator.manipulate(uri).resize({ width }).renderAsync();
  const resized = await image.saveAsync({ base64: true, compress: 0.92, format: SaveFormat.JPEG });

  if (!resized.base64) throw new Error('Resize produced no image data');

  const decoded = decodeJpeg(base64ToBytes(resized.base64), { useTArray: true, formatAsRGBA: true });
  return { data: decoded.data, width: decoded.width, height: decoded.height };
}

/** Write an RGBA crop out as a JPEG file, e.g. to hand to the OCR engine. */
export async function cropToFile(uri: string, region: { left: number; top: number; width: number; height: number }, imageWidth: number, imageHeight: number): Promise<string> {
  const result = await manipulateAsync(
    uri,
    [
      {
        crop: {
          originX: Math.round(region.left * imageWidth),
          originY: Math.round(region.top * imageHeight),
          width: Math.round(region.width * imageWidth),
          height: Math.round(region.height * imageHeight),
        },
      },
    ],
    { compress: 1, format: SaveFormat.JPEG },
  );
  return result.uri;
}
