/**
 * The scan pipeline: detect -> gate -> dewarp -> embed -> search -> confidence.
 *
 * Everything runs on the phone. The only I/O is loading the two ONNX models and
 * the fingerprint index once at start-up.
 */
import { InferenceSession, Tensor } from 'onnxruntime-react-native';
import { clamp01, isUsableQuad, orderCorners, Point, sigmoid } from './geometry';
import {
  DETECTOR_SIZE,
  EMBEDDER_SIZE,
  RgbaImage,
  dewarp,
  laplacianVariance,
  rotate180,
  squashResize,
  toImageNetTensor,
} from './image';
import { CORNELIUS, MILO, createSession } from './models';
import { Candidate, IndexPack, search, voteAcrossFrames } from './search';
import { ConfidenceResult, assessConfidence } from './confidence';

export interface Detection {
  corners: Point[];
  /** Detector's sharpness head, 0..1. Null when the model has no such output. */
  sharpness: number | null;
  confidence: number;
  cardPresent: boolean;
}

export interface ScanOptions {
  /** Below this the frame is treated as "no card". */
  minCornerConfidence?: number;
  /** Fraction of the frame the card must fill. */
  minQuadArea?: number;
  /** Embed the 180-degree rotation too and keep the stronger match. */
  tryRotated?: boolean;
  topK?: number;
}

const DEFAULTS: Required<ScanOptions> = {
  minCornerConfidence: 0.35,
  minQuadArea: 0.1,
  tryRotated: true,
  topK: 10,
};

export interface FrameResult {
  detection: Detection;
  /** Null when the frame was rejected before embedding. */
  crop: RgbaImage | null;
  embedding: Float32Array | null;
  candidates: Candidate[];
  rejected: string | null;
  timings: Record<string, number>;
}

export class ScanPipeline {
  private detector: InferenceSession | null = null;
  private embedder: InferenceSession | null = null;
  private index: IndexPack | null = null;
  private readonly options: Required<ScanOptions>;

  private detectorTensor = new Float32Array(3 * DETECTOR_SIZE * DETECTOR_SIZE);
  private embedderTensor = new Float32Array(3 * EMBEDDER_SIZE * EMBEDDER_SIZE);

  constructor(options: ScanOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  get ready(): boolean {
    return this.detector !== null && this.embedder !== null;
  }

  get indexPack(): IndexPack | null {
    return this.index;
  }

  async load(): Promise<void> {
    if (!this.detector) this.detector = await createSession(CORNELIUS);
    if (!this.embedder) this.embedder = await createSession(MILO);
  }

  setIndex(index: IndexPack | null): void {
    this.index = index;
  }

  async release(): Promise<void> {
    await this.detector?.release();
    await this.embedder?.release();
    this.detector = null;
    this.embedder = null;
  }

  /** Find the four corners of the card in a frame. */
  async detect(frame: RgbaImage): Promise<Detection> {
    if (!this.detector) throw new Error('Pipeline not loaded');

    // The detector was trained on squashed (aspect-ignoring) input, so its
    // normalised outputs map straight back onto the original frame.
    const squashed = squashResize(frame, DETECTOR_SIZE);
    toImageNetTensor(squashed, DETECTOR_SIZE, this.detectorTensor);

    const inputName = this.detector.inputNames[0];
    const outputs = await this.detector.run({
      [inputName]: new Tensor('float32', this.detectorTensor, [1, 3, DETECTOR_SIZE, DETECTOR_SIZE]),
    });

    const names = this.detector.outputNames;
    const cornersRaw = Array.from(outputs[names[0]].data as Float32Array).slice(0, 8);
    const presenceLogit = names.length > 1 ? Number((outputs[names[1]].data as Float32Array)[0]) : 0;
    const sharpness = names.length > 2 ? Number((outputs[names[2]].data as Float32Array)[0]) : null;

    const points: Point[] = [];
    for (let i = 0; i < 8; i += 2) {
      points.push([clamp01(cornersRaw[i]), clamp01(cornersRaw[i + 1])]);
    }

    const confidence = sharpness ?? sigmoid(presenceLogit);
    return {
      corners: orderCorners(points, frame.width, frame.height),
      sharpness,
      confidence,
      cardPresent: confidence >= this.options.minCornerConfidence,
    };
  }

  /** Milo embedding of a 448x448 crop, L2-normalised by the model itself. */
  async embed(crop: RgbaImage): Promise<Float32Array> {
    if (!this.embedder) throw new Error('Pipeline not loaded');

    toImageNetTensor(crop, EMBEDDER_SIZE, this.embedderTensor);
    const inputName = this.embedder.inputNames[0];
    const outputs = await this.embedder.run({
      [inputName]: new Tensor('float32', this.embedderTensor, [1, 3, EMBEDDER_SIZE, EMBEDDER_SIZE]),
    });

    return Float32Array.from(outputs[this.embedder.outputNames[0]].data as Float32Array);
  }

  /**
   * Run one frame end to end. Frames that fail the gate return early with a
   * reason, which is what drives the on-screen guidance.
   */
  async processFrame(frame: RgbaImage): Promise<FrameResult> {
    const timings: Record<string, number> = {};
    const started = Date.now();

    const detection = await this.detect(frame);
    timings.detectMs = Date.now() - started;

    const reject = (reason: string): FrameResult => ({
      detection,
      crop: null,
      embedding: null,
      candidates: [],
      rejected: reason,
      timings,
    });

    if (!detection.cardPresent) return reject('no-card');
    if (!isUsableQuad(detection.corners)) return reject('bad-quad');
    if (quadCoverage(detection.corners) < this.options.minQuadArea) return reject('too-small');

    const dewarpStart = Date.now();
    const crop = dewarp(frame, detection.corners, EMBEDDER_SIZE);
    timings.dewarpMs = Date.now() - dewarpStart;

    const embedStart = Date.now();
    let embedding = await this.embed(crop);
    let candidates = this.index ? search(this.index, embedding, this.options.topK) : [];

    // Milo is sensitive to upside-down cards, so try the rotation and keep
    // whichever direction matched more strongly.
    if (this.options.tryRotated && this.index) {
      const rotatedEmbedding = await this.embed(rotate180(crop));
      const rotatedCandidates = search(this.index, rotatedEmbedding, this.options.topK);
      const bestUpright = candidates[0]?.score ?? -Infinity;
      const bestRotated = rotatedCandidates[0]?.score ?? -Infinity;
      if (bestRotated > bestUpright) {
        embedding = rotatedEmbedding;
        candidates = rotatedCandidates;
      }
    }
    timings.embedMs = Date.now() - embedStart;
    timings.totalMs = Date.now() - started;

    return { detection, crop, embedding, candidates, rejected: null, timings };
  }
}

/** Fraction of the frame the quad covers (normalised coordinates). */
export function quadCoverage(corners: Point[]): number {
  let area = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const [x1, y1] = corners[i];
    const [x2, y2] = corners[(i + 1) % corners.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) * 0.5;
}

/**
 * Combine several frames into one answer. This is what the UI shows: the
 * voted candidate list plus a tier saying how much to trust it.
 */
export function combineFrames(
  frames: FrameResult[],
  ocrAgrees: boolean | null = null,
): { candidates: Candidate[]; confidence: ConfidenceResult } {
  const usable = frames.filter((frame) => frame.candidates.length > 0);
  const candidates = voteAcrossFrames(usable.map((frame) => frame.candidates));
  const sharpness = usable.length > 0 ? usable[usable.length - 1].detection.sharpness : null;

  return {
    candidates,
    confidence: assessConfidence({
      candidates,
      frameCount: usable.length,
      ocrAgrees,
      sharpness,
    }),
  };
}

/** Steadiness/sharpness gate, applied before a frame is worth embedding. */
export class CaptureGate {
  private history: Point[][] = [];

  constructor(
    private readonly stableFrames = 3,
    private readonly maxDrift = 0.04,
    private readonly minSharpness = 12,
  ) {}

  reset(): void {
    this.history = [];
  }

  /** True when the card has held still and in focus for long enough. */
  accept(corners: Point[], frame: RgbaImage): { locked: boolean; reason: string | null } {
    this.history.push(corners);
    if (this.history.length > this.stableFrames) this.history.shift();

    if (laplacianVariance(frame) < this.minSharpness) {
      return { locked: false, reason: 'blurry' };
    }
    if (this.history.length < this.stableFrames) {
      return { locked: false, reason: 'steadying' };
    }

    const first = this.history[0];
    for (const quad of this.history.slice(1)) {
      for (let i = 0; i < 4; i += 1) {
        const dx = quad[i][0] - first[i][0];
        const dy = quad[i][1] - first[i][1];
        if (Math.hypot(dx, dy) > this.maxDrift) return { locked: false, reason: 'moving' };
      }
    }

    return { locked: true, reason: null };
  }
}
