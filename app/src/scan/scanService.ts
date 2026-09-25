/**
 * Puts the pieces together: frames in, an identified printing out.
 *
 * Kept free of React so it can be driven by the accuracy harness in /testset as
 * well as by the camera screen.
 */
import { printingsForArt } from '../data/db';
import { GameId, Printing } from '../data/types';
import { loadFrame } from './capture';
import { ConfidenceResult } from './confidence';
import { OCR_REGIONS, OcrProvider, ParsedCorner, PrintingScore, ocrAgreement, parseCornerText, rankPrintings } from './ocr';
import { CaptureGate, FrameResult, ScanPipeline, combineFrames } from './pipeline';
import { Candidate } from './search';

export interface ScanCandidate {
  artId: string;
  score: number;
  printings: Printing[];
}

export interface ScanResult {
  /** Best printing, or null when nothing plausible was found. */
  printing: Printing | null;
  candidates: ScanCandidate[];
  confidence: ConfidenceResult;
  parsedCorner: ParsedCorner | null;
  printingScores: PrintingScore[];
  embedding: Float32Array | null;
  frames: FrameResult[];
  timings: Record<string, number>;
}

export interface ScanServiceOptions {
  gameId: GameId;
  /** Frames to embed before answering. CollectorVision votes across 3. */
  framesPerScan?: number;
  ocr?: OcrProvider | null;
}

export class ScanService {
  readonly pipeline: ScanPipeline;
  readonly gate = new CaptureGate();
  private frames: FrameResult[] = [];

  constructor(private options: ScanServiceOptions, pipeline = new ScanPipeline()) {
    this.pipeline = pipeline;
  }

  async load(): Promise<void> {
    await this.pipeline.load();
  }

  reset(): void {
    this.frames = [];
    this.gate.reset();
  }

  setGame(gameId: GameId): void {
    this.options = { ...this.options, gameId };
    this.reset();
  }

  get framesCollected(): number {
    return this.frames.length;
  }

  /**
   * Feed one photo file. Decodes it to RGBA, then hands off to {@link offerImage}.
   * Used by the accuracy harness and any file-based path.
   */
  async offerPhoto(uri: string): Promise<{ result: ScanResult | null; status: string }> {
    const frame = await loadFrame(uri);
    return this.offerImage(frame, uri);
  }

  /**
   * Feed one already-decoded RGBA frame — the live camera path, which gets the
   * pixels straight from the camera pipeline (off the UI thread) and so skips
   * the JPEG decode entirely. Returns a result once enough frames have agreed,
   * or null while it is still gathering, along with why nothing happened.
   *
   * `photoUri` is only needed for OCR disambiguation, which the live path does
   * not have a file for; passing null simply skips OCR.
   */
  async offerImage(
    frame: import('./image').RgbaImage,
    photoUri: string | null = null,
  ): Promise<{ result: ScanResult | null; status: string }> {
    const processed = await this.pipeline.processFrame(frame);

    if (processed.rejected) {
      this.gate.reset();
      return { result: null, status: processed.rejected };
    }

    const gate = this.gate.accept(processed.detection.corners, frame);
    if (!gate.locked) return { result: null, status: gate.reason ?? 'waiting' };

    this.frames.push(processed);
    const wanted = this.options.framesPerScan ?? 3;
    if (this.frames.length < wanted) {
      return { result: null, status: `frame ${this.frames.length}/${wanted}` };
    }

    const result = await this.finish(photoUri);
    this.reset();
    return { result, status: 'done' };
  }

  /** Resolve the frames gathered so far into a result. */
  async finish(photoUri: string | null): Promise<ScanResult> {
    const started = Date.now();
    const voted = combineFrames(this.frames);

    const candidates = await this.expandCandidates(voted.candidates);
    const topPrintings = candidates[0]?.printings ?? [];

    let parsedCorner: ParsedCorner | null = null;
    let printingScores: PrintingScore[] = [];
    let chosen: Printing | null = topPrintings[0] ?? null;

    // Only bother with OCR when the artwork exists in more than one printing —
    // that is the only case it can change the answer.
    const needsDisambiguation = topPrintings.length > 1;
    if (needsDisambiguation && this.options.ocr && photoUri) {
      try {
        const region = OCR_REGIONS[this.options.gameId];
        const boxes = await this.options.ocr.recognise(photoUri);
        parsedCorner = parseCornerText(boxes);
        printingScores = rankPrintings(
          candidates.flatMap((candidate) => candidate.printings),
          parsedCorner,
        );
        if (printingScores.length > 0) chosen = printingScores[0].printing;
        void region;
      } catch {
        // OCR is corroboration, never a hard dependency.
        parsedCorner = null;
      }
    }

    const confidence = combineFrames(this.frames, ocrAgreement(printingScores, chosen)).confidence;
    const embedding = this.frames[this.frames.length - 1]?.embedding ?? null;

    return {
      printing: chosen,
      candidates,
      confidence,
      parsedCorner,
      printingScores,
      embedding,
      frames: [...this.frames],
      timings: { totalMs: Date.now() - started },
    };
  }

  private async expandCandidates(candidates: Candidate[]): Promise<ScanCandidate[]> {
    const expanded: ScanCandidate[] = [];
    for (const candidate of candidates.slice(0, 5)) {
      const printings = await printingsForArt(candidate.artId);
      expanded.push({ artId: candidate.artId, score: candidate.score, printings });
    }
    return expanded;
  }
}
