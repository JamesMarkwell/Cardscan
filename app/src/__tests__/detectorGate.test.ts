/**
 * Card-present gating in ScanPipeline.detect.
 *
 * The bundled corner detector's `presence` head is constant (1.0 for every input,
 * flat grey included) and its `sharpness` head is the one that separates "card in
 * frame" (~0.05-0.07) from "nothing there" (~0.01). These tests pin that, using
 * the values measured from the real model and from a real phone scan (0.07).
 */
import { ScanPipeline } from '../scan/pipeline';

// The pipeline pulls in native modules (ONNX, asset unpacking) at import time;
// none of that is needed to test the gate.
jest.mock('../scan/ort', () => ({
  InferenceSession: class {},
  Tensor: class {
    constructor(
      public type: string,
      public data: Float32Array,
      public dims: number[],
    ) {}
  },
}));
jest.mock('../scan/models', () => ({ CORNELIUS: {}, MILO: {}, createSession: jest.fn() }));

const CORNERS = [0.13, 0.8, 0.92, 0.82, 0.17, 0.01, 0.91, 0.02];

/** A pipeline whose detector returns the given head values. */
function pipelineWithDetector(outputs: { presence: number; sharpness: number | null }): ScanPipeline {
  const pipeline = new ScanPipeline();
  const outputNames = outputs.sharpness === null ? ['corners', 'presence'] : ['corners', 'presence', 'sharpness'];
  const fake = {
    inputNames: ['image'],
    outputNames,
    run: async () => ({
      corners: { data: Float32Array.from(CORNERS), dims: [1, 8] },
      presence: { data: Float32Array.from([outputs.presence]), dims: [1] },
      ...(outputs.sharpness === null ? {} : { sharpness: { data: Float32Array.from([outputs.sharpness]), dims: [1] } }),
    }),
  };
  (pipeline as unknown as { detector: unknown }).detector = fake;
  return pipeline;
}

function frame(): { data: Uint8Array; width: number; height: number } {
  return { data: new Uint8Array(16 * 16 * 4), width: 16, height: 16 };
}

describe('ScanPipeline card-present gate', () => {
  it('accepts a card-in-frame reading on the sharpness head (0.07 from a real phone scan)', async () => {
    const detection = await pipelineWithDetector({ presence: 1, sharpness: 0.07 }).detect(frame());
    expect(detection.cardPresent).toBe(true);
    expect(detection.confidence).toBeCloseTo(0.07, 5);
  });

  it('rejects a nothing-in-view reading even though the presence head says 1.0', async () => {
    const detection = await pipelineWithDetector({ presence: 1, sharpness: 0.01 }).detect(frame());
    expect(detection.cardPresent).toBe(false);
  });

  it('falls back to the presence head when a model has no sharpness head', async () => {
    const present = await pipelineWithDetector({ presence: 2, sharpness: null }).detect(frame());
    expect(present.cardPresent).toBe(true);
    const absent = await pipelineWithDetector({ presence: -4, sharpness: null }).detect(frame());
    expect(absent.cardPresent).toBe(false);
  });
});
