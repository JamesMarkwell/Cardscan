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
import { SaveFormat, manipulateAsync } from 'expo-image-manipulator';
import { decode as decodeJpeg } from 'jpeg-js';
import { base64ToBytes } from './base64';
import { RgbaImage } from './image';

/** Working width. TCGplayer's own guidance is that resolution past ~100 DPI adds nothing. */
export const WORKING_WIDTH = 540;

/** Load a photo file as an RGBA buffer, downscaled to the working width. */
export async function loadFrame(uri: string, width = WORKING_WIDTH): Promise<RgbaImage> {
  const resized = await manipulateAsync(uri, [{ resize: { width } }], {
    base64: true,
    compress: 0.92,
    format: SaveFormat.JPEG,
  });

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
