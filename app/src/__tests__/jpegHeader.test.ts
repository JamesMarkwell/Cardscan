import { readJpegDimensions } from '../scan/jpegHeader';

/** Build a minimal JPEG: SOI, an APP0 segment, a baseline SOF0 with the given
 * dimensions, then SOS. Enough for the header reader; not a decodable image. */
function jpegWithSof(width: number, height: number, sofMarker = 0xc0): Uint8Array {
  const bytes: number[] = [0xff, 0xd8]; // SOI
  // APP0 (JFIF) — a length-bearing segment the reader must skip over.
  bytes.push(0xff, 0xe0, 0x00, 0x04, 0x00, 0x00);
  // SOFn: length (17), precision (8), height hi/lo, width hi/lo, components...
  bytes.push(0xff, sofMarker, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03);
  for (let i = 0; i < 9; i += 1) bytes.push(0x00); // component specs padding
  bytes.push(0xff, 0xda); // SOS
  return Uint8Array.from(bytes);
}

describe('readJpegDimensions', () => {
  it('reads dimensions from a baseline (SOF0) JPEG, skipping earlier segments', () => {
    expect(readJpegDimensions(jpegWithSof(1280, 720))).toEqual({ width: 1280, height: 720 });
  });

  it('reads dimensions from a progressive (SOF2) JPEG', () => {
    expect(readJpegDimensions(jpegWithSof(4032, 3024, 0xc2))).toEqual({ width: 4032, height: 3024 });
  });

  it('returns null for non-JPEG bytes', () => {
    expect(readJpegDimensions(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(readJpegDimensions(Uint8Array.from([0xff, 0xd8]))).toBeNull();
  });
});
