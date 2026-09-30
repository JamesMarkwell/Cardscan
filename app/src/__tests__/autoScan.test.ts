import {
  AWAY_SAMPLES,
  CHANGED_DIFF,
  SAMPLE_INTERVAL_MS,
  STABLE_SAMPLES,
  STILL_DIFF,
  THUMB_COLS,
  THUMB_ROWS,
  createAutoScanState,
  meanAbsDiff,
  sampleThumbnail,
  shouldSample,
  stepAutoScan,
} from '../scan/autoScan';

/** A flat thumbnail of one brightness. */
const flat = (value: number) => new Array<number>(THUMB_COLS * THUMB_ROWS).fill(value);

/** Feed the same thumbnail `times` times, returning whether any step triggered. */
function feed(state: ReturnType<typeof createAutoScanState>, thumb: number[], times: number, start = 0) {
  let triggered = 0;
  for (let i = 0; i < times; i += 1) {
    if (stepAutoScan(state, thumb, start + i * SAMPLE_INTERVAL_MS).trigger) triggered += 1;
  }
  return triggered;
}

describe('sampleThumbnail', () => {
  /** A width x height frame of `channels` bytes/pixel where green = f(x, y). */
  function frame(width: number, height: number, channels: number, bytesPerRow: number, green: (x: number, y: number) => number) {
    const pixels = new Uint8Array(bytesPerRow * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) pixels[y * bytesPerRow + x * channels + 1] = green(x, y);
    }
    return pixels;
  }

  it('has one cell per grid position', () => {
    const thumb = sampleThumbnail(frame(160, 240, 4, 640, () => 100), 160, 240, 640, 4, 1);
    expect(thumb).toHaveLength(THUMB_COLS * THUMB_ROWS);
    expect(thumb.every((value) => value === 100)).toBe(true);
  });

  it('reads the green channel at the given offset, ignoring row padding', () => {
    // 3 bytes/pixel with 16 bytes of padding per row; green is byte 1 of a pixel.
    const width = 64;
    const height = 96;
    const bytesPerRow = width * 3 + 16;
    const pixels = frame(width, height, 3, bytesPerRow, () => 200);
    for (let y = 0; y < height; y += 1) pixels.fill(7, y * bytesPerRow + width * 3, (y + 1) * bytesPerRow); // padding
    const thumb = sampleThumbnail(pixels, width, height, bytesPerRow, 3, 1);
    expect(Math.min(...thumb)).toBe(200);
    expect(Math.max(...thumb)).toBe(200);
  });

  it('shows where the bright part of the scene is', () => {
    // Bright on the left half only.
    const pixels = frame(160, 240, 4, 640, (x) => (x < 80 ? 220 : 20));
    const thumb = sampleThumbnail(pixels, 160, 240, 640, 4, 1);
    expect(thumb[0]).toBeGreaterThan(200); // top-left
    expect(thumb[THUMB_COLS - 1]).toBeLessThan(40); // top-right
  });

  it('stays inside a frame smaller than the grid blocks', () => {
    const thumb = sampleThumbnail(frame(8, 8, 4, 32, () => 50), 8, 8, 32, 4, 1);
    expect(thumb.every((value) => value === 50)).toBe(true);
  });
});

describe('meanAbsDiff', () => {
  it('averages the per-cell difference', () => {
    expect(meanAbsDiff(flat(10), flat(10))).toBe(0);
    expect(meanAbsDiff(flat(10), flat(30))).toBe(20);
  });
});

describe('shouldSample', () => {
  it('waits out the sample interval', () => {
    const state = createAutoScanState();
    stepAutoScan(state, flat(0), 1000);
    expect(shouldSample(state, 1000 + SAMPLE_INTERVAL_MS - 1)).toBe(false);
    expect(shouldSample(state, 1000 + SAMPLE_INTERVAL_MS)).toBe(true);
  });
});

describe('stepAutoScan', () => {
  it('triggers once the scene has been held still long enough', () => {
    const state = createAutoScanState();
    // The first sample has nothing to compare with, so needs STABLE_SAMPLES more after it.
    expect(feed(state, flat(100), STABLE_SAMPLES)).toBe(0);
    expect(stepAutoScan(state, flat(100), 10_000).trigger).toBe(true);
  });

  it('does not trigger while the picture is moving', () => {
    const state = createAutoScanState();
    let triggered = 0;
    for (let i = 0; i < 40; i += 1) {
      // Brightness swinging by more than the still threshold each sample.
      triggered += stepAutoScan(state, flat(i % 2 === 0 ? 60 : 60 + STILL_DIFF + 10), i * SAMPLE_INTERVAL_MS).trigger ? 1 : 0;
    }
    expect(triggered).toBe(0);
  });

  it('forgives small jitter but not a real movement', () => {
    const state = createAutoScanState();
    const jitter = flat(100).map((value, i) => value + (i % 2 === 0 ? 1 : -1)); // ~1 grey level
    expect(feed(state, jitter, STABLE_SAMPLES + 2)).toBe(1);
  });

  it('a movement part-way through starts the count again', () => {
    const state = createAutoScanState();
    feed(state, flat(100), STABLE_SAMPLES - 1);
    stepAutoScan(state, flat(100 + STILL_DIFF + 20), 5000); // a jolt
    // The first sample after the jolt only registers the change; then the picture
    // must hold still for STABLE_SAMPLES samples before a scan fires.
    expect(feed(state, flat(140), STABLE_SAMPLES, 6000)).toBe(0);
    expect(stepAutoScan(state, flat(140), 20_000).trigger).toBe(true);
  });

  it('scans a scene once, however long it stays in view', () => {
    const state = createAutoScanState();
    expect(feed(state, flat(100), 200)).toBe(1);
  });

  /** A scene with structure: `phase` picks which cells are bright, `level` the overall exposure. */
  const stripes = (phase: number, level = 100) =>
    new Array<number>(THUMB_COLS * THUMB_ROWS).fill(0).map((_, i) => level + (((i + phase) % 2) * 2 - 1) * 40);

  it('scans again only after the scene changes and settles', () => {
    const state = createAutoScanState();
    expect(feed(state, stripes(0), 30)).toBe(1);
    // A slight change is not a new card…
    const nudged = stripes(0).map((v, i) => v + (i % 7 === 0 ? CHANGED_DIFF - 4 : 0));
    expect(feed(state, nudged, 30, 10_000)).toBe(0);
    // …a clearly different scene is.
    expect(feed(state, stripes(1), 30, 20_000)).toBe(1);
  });

  it('ignores exposure drifting: the same picture brighter or darker is not a new card', () => {
    const state = createAutoScanState();
    expect(feed(state, stripes(0, 100), 30)).toBe(1);
    expect(feed(state, stripes(0, 160), 30, 10_000)).toBe(0);
    expect(feed(state, stripes(0, 60), 30, 20_000)).toBe(0);
  });

  it('a brief change (a passing hand) does not re-arm the scan', () => {
    const state = createAutoScanState();
    expect(feed(state, stripes(0), 30)).toBe(1);
    // One odd sample fewer than it takes to count as a new card.
    for (let i = 0; i < AWAY_SAMPLES - 1; i += 1) stepAutoScan(state, stripes(1), 10_000 + i * SAMPLE_INTERVAL_MS);
    expect(feed(state, stripes(0), 30, 11_000)).toBe(0);
  });

  it('a new card settles and is scanned within about half a second', () => {
    const state = createAutoScanState();
    expect(feed(state, stripes(0), 30)).toBe(1);
    // The next card: it must differ for AWAY_SAMPLES samples and hold still for STABLE_SAMPLES.
    let steps = 0;
    let triggered = false;
    while (!triggered && steps < 20) {
      triggered = stepAutoScan(state, stripes(1), 10_000 + steps * SAMPLE_INTERVAL_MS).trigger;
      steps += 1;
    }
    expect(triggered).toBe(true);
    expect(steps * SAMPLE_INTERVAL_MS).toBeLessThanOrEqual(700);
  });

  it('survives a pause: coming back to the same scene does not scan it twice', () => {
    const state = createAutoScanState();
    feed(state, flat(100), 30); // scanned
    // Camera off for a while (result sheet), then back on the same card.
    expect(feed(state, flat(102), 30, 60_000)).toBe(0);
  });

  it('reports how far the picture moved, for tuning', () => {
    const state = createAutoScanState();
    stepAutoScan(state, flat(100), 0);
    const step = stepAutoScan(state, flat(103), 120);
    expect(step.still).toBe(3);
    expect(step.trigger).toBe(false);
  });
});
