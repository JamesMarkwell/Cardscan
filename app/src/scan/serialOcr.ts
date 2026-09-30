/**
 * Reading a card's serial number off the frame.
 *
 * Cuts the strip of the card that holds the printed code out of the camera frame
 * (flattened, at the card's true proportions), hands it to the on-device text
 * recogniser, and parses the serial out of what comes back. The detector gives
 * the card's corners but not which way up it is, so the four turns are tried in
 * turn and the first that yields a serial wins — a serial's shape is specific
 * enough that reading one from the wrong orientation is very unlikely.
 *
 * The recogniser is the local `expo-ocr` native module (ML Kit, bundled model,
 * fully offline). It is resolved lazily so importing this file off-device
 * (tests, tooling) does not need the native module present.
 */
import { requestNative } from './serialNative';
import { GameId } from '../data/types';
import { Point } from './geometry';
import { RgbaImage, dewarpRegion } from './image';
import { OCR_REGIONS } from './ocr';
import { parseSerial } from './serial';

// Real card dimensions (mm). Only the ratio matters: it sets the strip's shape so
// the text is not stretched.
const CARD_WIDTH_MM = 63;
const CARD_HEIGHT_MM = 88;

// The strip is sampled wide enough for a small serial to be legible; a serial is
// a couple of millimetres tall on a card that is ~600px across in the frame.
const STRIP_WIDTH = 640;

// Which cyclic shift of the corners to try, in order. 0 is the card upright in
// the frame, which is the common case.
const ORIENTATIONS = [0, 1, 3, 2];

/** Pack RGBA pixels into signed 32-bit ARGB integers, as an Android Bitmap wants. */
export function toArgbPixels(image: RgbaImage): number[] {
  const count = image.width * image.height;
  const out = new Array<number>(count);
  for (let i = 0; i < count; i += 1) {
    const s = i * 4;
    // `|` yields a signed 32-bit result, which is what the native IntArray takes.
    out[i] = (255 << 24) | (image.data[s] << 16) | (image.data[s + 1] << 8) | image.data[s + 2];
  }
  return out;
}

/** Size of the strip to sample for a game's serial region, at the card's own proportions. */
export function stripSize(game: GameId, width = STRIP_WIDTH): { width: number; height: number } {
  const region = OCR_REGIONS[game];
  const aspect = (region.width * CARD_WIDTH_MM) / (region.height * CARD_HEIGHT_MM);
  return { width, height: Math.max(32, Math.round(width / aspect)) };
}

/**
 * Read the serial off a card in the frame, or null if none could be read.
 * `corners` are the detector's, ordered TL, TR, BR, BL in normalised coordinates.
 */
export async function readSerial(
  game: GameId,
  frame: RgbaImage,
  corners: Point[],
  trace?: (message: string) => void,
): Promise<string | null> {
  const region = OCR_REGIONS[game];
  const { width, height } = stripSize(game);

  for (const shift of ORIENTATIONS) {
    // Turning the card a quarter turn in the frame just re-labels which corner is
    // its top-left, so cycling the corners reads the same physical strip.
    const turned = [0, 1, 2, 3].map((i) => corners[(i + shift) % 4]);
    const started = Date.now();
    const strip = dewarpRegion(frame, turned, region, width, height);
    const lines = await requestNative(toArgbPixels(strip), strip.width, strip.height);
    trace?.(`ocr: orientation ${shift} (${Date.now() - started}ms) ${JSON.stringify(lines).slice(0, 140)}`);

    const serial = parseSerial(game, lines);
    if (serial) return serial;
  }
  return null;
}
