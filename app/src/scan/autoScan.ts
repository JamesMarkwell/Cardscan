/**
 * When should auto-scan take a picture?
 *
 * Live scanning used to send every camera frame to the JavaScript thread and run
 * the whole pipeline on it, which froze the UI. This does the opposite: the camera
 * thread keeps only a tiny brightness thumbnail of the scene (a few hundred pixel
 * reads, no data crossing to JavaScript) and decides from those alone when to
 * grab ONE full frame — after the picture has been held still for a moment, and
 * only if it differs from the scene that was last scanned. So a card left sitting
 * under the camera is scanned once, and the next card triggers a fresh scan.
 *
 * Every function runs on the camera's worklet thread, hence the 'worklet'
 * directives (plain functions everywhere else, so the tests can call them). They
 * take and return plain numbers and arrays only.
 */

/** Thumbnail grid: coarse on purpose — it is only for spotting motion. */
export const THUMB_COLS = 16;
export const THUMB_ROWS = 24;

/** Mean brightness change (0-255) between samples below which the picture is "still". */
export const STILL_DIFF = 4;
/** Structural change (overall brightness removed) from the last scanned scene above which it counts as a new scene. */
export const CHANGED_DIFF = 10;
/** Consecutive samples that must differ from the scanned scene before a new card counts. */
export const AWAY_SAMPLES = 2;
/** Consecutive still samples needed before a picture is taken (~0.3s at the sample rate). */
export const STABLE_SAMPLES = 3;
/** Minimum time between samples, so a fast camera costs no more than a slow one. */
export const SAMPLE_INTERVAL_MS = 100;

export interface AutoScanState {
  /** The previous sample, for spotting motion. */
  prev: number[] | null;
  /** The scene at the last trigger; a new scene must differ from it to trigger again. */
  ref: number[] | null;
  /** How many samples in a row have been still. */
  stable: number;
  /** How many samples in a row have differed from the scanned scene. */
  away: number;
  /** Whether a trigger is allowed: true until one fires, then only once the scene changes. */
  armed: boolean;
  /** When the last sample was taken (ms), or 0. */
  lastSampleAt: number;
}

export function createAutoScanState(): AutoScanState {
  'worklet';
  return { prev: null, ref: null, stable: 0, away: 0, armed: true, lastSampleAt: 0 };
}

/** Whether enough time has passed to take another sample. */
export function shouldSample(state: AutoScanState, now: number): boolean {
  'worklet';
  return now - state.lastSampleAt >= SAMPLE_INTERVAL_MS;
}

/**
 * A THUMB_COLS x THUMB_ROWS brightness thumbnail of a frame. Each cell averages a
 * small block of the green channel (which carries most of the brightness), so
 * sensor noise does not read as motion.
 *
 * `channels` is bytes per pixel (3 or 4) and `greenAt` the offset of the green
 * byte within a pixel; `bytesPerRow` may exceed `width * channels` (padding).
 */
export function sampleThumbnail(
  pixels: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
  channels: number,
  greenAt: number,
): number[] {
  'worklet';
  const out = new Array<number>(THUMB_COLS * THUMB_ROWS);
  const block = 4;
  for (let row = 0; row < THUMB_ROWS; row += 1) {
    const centreY = Math.floor(((row + 0.5) * height) / THUMB_ROWS);
    for (let col = 0; col < THUMB_COLS; col += 1) {
      const centreX = Math.floor(((col + 0.5) * width) / THUMB_COLS);
      let sum = 0;
      let count = 0;
      for (let dy = 0; dy < block; dy += 1) {
        const y = Math.min(height - 1, Math.max(0, centreY + dy - 2));
        for (let dx = 0; dx < block; dx += 1) {
          const x = Math.min(width - 1, Math.max(0, centreX + dx - 2));
          sum += pixels[y * bytesPerRow + x * channels + greenAt];
          count += 1;
        }
      }
      out[row * THUMB_COLS + col] = sum / count;
    }
  }
  return out;
}

/** Mean absolute difference between two thumbnails. */
export function meanAbsDiff(a: number[], b: number[]): number {
  'worklet';
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

/**
 * How different two scenes look, ignoring overall brightness: each thumbnail has
 * its own mean removed first, so exposure drifting or a hand's shadow does not read
 * as a new card, while a different picture still does.
 */
export function sceneDistance(a: number[], b: number[]): number {
  'worklet';
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < a.length; i += 1) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= a.length;
  meanB /= b.length;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - meanA - (b[i] - meanB));
  return total / a.length;
}

export interface AutoScanStep {
  /** The thumbnail this step saw, so the caller can tell a repeat of a scanned scene. */
  thumb: number[];
  /** True when a picture should be taken now. */
  trigger: boolean;
  /** Change from the previous sample (large before the first). */
  still: number;
  /** Change from the last scanned scene (large before any). */
  changed: number;
}

/**
 * Feed one thumbnail in. Fires a trigger once the scene has been still for
 * STABLE_SAMPLES samples while armed; firing disarms until the scene next changes.
 */
export function stepAutoScan(state: AutoScanState, thumb: number[], now: number): AutoScanStep {
  'worklet';
  state.lastSampleAt = now;

  const still = state.prev ? meanAbsDiff(thumb, state.prev) : 1000;
  state.prev = thumb;
  state.stable = still <= STILL_DIFF ? state.stable + 1 : 0;

  const changed = state.ref ? sceneDistance(thumb, state.ref) : 1000;
  // A new card must stay different for a few samples: a passing hand is not one.
  state.away = changed >= CHANGED_DIFF ? state.away + 1 : 0;
  if (!state.armed && state.away >= AWAY_SAMPLES) state.armed = true;

  if (state.armed && state.stable >= STABLE_SAMPLES) {
    state.ref = thumb;
    state.armed = false;
    state.stable = 0;
    state.away = 0;
    return { trigger: true, still, changed, thumb };
  }
  return { trigger: false, still, changed, thumb };
}
