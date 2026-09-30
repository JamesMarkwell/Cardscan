/**
 * Reading a JPEG's dimensions from its header, without decoding it.
 *
 * Kept in its own module — free of any native import — so it can be unit-tested
 * and used to reject an over-large capture before the expensive pure-JS decode.
 */

/**
 * The most pixels we will hand to the pure-JS decoder. jpeg-js is our only
 * decode path that doesn't hang on this build, but it decodes on the JS thread
 * and its cost scales with pixel count — a full-resolution ~12 MP sensor image
 * takes tens of seconds and looks frozen. ~3.5 MP comfortably covers 1080p/720p
 * captures; anything bigger means the camera ignored our resolution request.
 */
export const MAX_DECODE_PIXELS = 3_500_000;

/**
 * Read a JPEG's pixel dimensions straight from its header, without decoding it.
 * Cheap (scans a few marker segments) and lets us both surface the real capture
 * size and reject an over-large image before the expensive decode. Returns null
 * if the bytes are not a JPEG we can read a frame header from.
 */
export function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = bytes[offset + 1];
    // Skip any fill bytes (0xFF padding) before the real marker.
    while (marker === 0xff && offset + 1 < bytes.length) {
      offset += 1;
      marker = bytes[offset + 1];
    }
    offset += 2;
    // Standalone markers with no length payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    // Start-Of-Frame markers carry the image dimensions (skip DHT/DAC/DNL: C4/C8/CC).
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof && offset + 6 < bytes.length) {
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return { width, height };
    }
    if (segmentLength < 2) break;
    offset += segmentLength;
  }
  return null;
}
