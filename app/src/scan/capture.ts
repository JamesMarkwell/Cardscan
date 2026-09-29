/**
 * Turning a camera photo into the RGBA buffer the pipeline works on.
 *
 * Hard-won lesson from this device: the native image libraries can't be trusted
 * here. Every nitro-image and expo-image-manipulator call — async or sync —
 * either never resolves or jams the JS thread so hard that even a setTimeout
 * can't fire ("Reading photo…" forever). The only decode that reliably runs is
 * jpeg-js, which is pure JavaScript and so cannot hang on a native bridge. Its
 * one weakness is memory: decoding a full-resolution sensor image allocates tens
 * of MB and OOM-crashes. We avoid that by forcing a small camera *format* (see
 * ScanScreen) so the captured JPEG is modest, then decode it here with generous
 * memory guards that turn any surprise large image into a catchable error rather
 * than a crash. The full-res buffer is downscaled to the working width in JS
 * before it reaches the pipeline, which expects a ~540px frame.
 */
import { ImageManipulator, SaveFormat, manipulateAsync } from 'expo-image-manipulator';
import { decode as decodeJpeg } from 'jpeg-js';
import { base64ToBytes } from './base64';
import { RgbaImage } from './image';

/** Working width. TCGplayer's own guidance is that resolution past ~100 DPI adds nothing. */
export const WORKING_WIDTH = 540;

/**
 * Decode encoded JPEG bytes (straight from the camera's photo output) into an
 * RGBA buffer, downscaled to the working width. Pure JS — no native image
 * library, which is the whole point: those hang on this build. The memory guards
 * make an unexpectedly large image throw (caught upstream as a readable "Scan
 * error") instead of OOM-crashing the app.
 */
export function decodeJpegToRgba(bytes: Uint8Array, width = WORKING_WIDTH): RgbaImage {
  const decoded = decodeJpeg(bytes, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: 25,
    maxMemoryUsageInMB: 128,
  });
  return downscaleRgba({ data: decoded.data, width: decoded.width, height: decoded.height }, width);
}

/** Nearest-neighbour downscale to a target width. Cheap and good enough — the
 * detector and embedder work on much smaller crops anyway. A no-op when the
 * source is already at or below the target width. */
function downscaleRgba(src: RgbaImage, targetWidth: number): RgbaImage {
  if (src.width <= targetWidth) return src;
  const scale = targetWidth / src.width;
  const w = targetWidth;
  const h = Math.max(1, Math.round(src.height * scale));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(src.height - 1, Math.floor(y / scale));
    const srow = sy * src.width * 4;
    const orow = y * w * 4;
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(src.width - 1, Math.floor(x / scale));
      const s = srow + sx * 4;
      const d = orow + x * 4;
      out[d] = src.data[s];
      out[d + 1] = src.data[s + 1];
      out[d + 2] = src.data[s + 2];
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
