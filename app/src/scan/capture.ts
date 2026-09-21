/**
 * Turning a camera photo into the RGBA buffer the pipeline works on.
 *
 * The native resize does the heavy lifting: decoding a full-resolution photo in
 * JavaScript would be far too slow, but a ~720px working buffer decodes in a
 * few tens of milliseconds and is more than the 384/448 models need.
 */
import { SaveFormat, manipulateAsync } from 'expo-image-manipulator';
import { decode as decodeJpeg } from 'jpeg-js';
import { base64ToBytes } from './base64';
import { RgbaImage } from './image';

/** Working width. TCGplayer's own guidance is that resolution past ~100 DPI adds nothing. */
export const WORKING_WIDTH = 720;

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
