/**
 * Puts the pieces together: frames in, an identified printing out.
 *
 * Kept free of React so it can be driven by the accuracy harness in /testset as
 * well as by the camera screen.
 */
import { printingsForIndexRow, printingsMatchingSerials } from '../data/db';
import { GameId, Printing } from '../data/types';
import { loadFrame } from './capture';
import { ConfidenceResult, assessConfidence } from './confidence';
import { Point } from './geometry';
import { RgbaImage } from './image';
import { OCR_REGIONS, OcrProvider, ParsedCorner, PrintingScore, ocrAgreement, parseCornerText, rankPrintings } from './ocr';
import { CaptureGate, FrameResult, ScanPipeline, combineFrames } from './pipeline';
import { Candidate } from './search';
import {
  SERIAL_GAMES,
  SerialChoice,
  SerialMatch,
  chooseSerial,
  nearSerialPatterns,
  rankPrintingsBySerial,
  serialConfidence,
  serialSet,
} from './serial';

/** A serial read off a card, with the rest of the text read from the same strip. */
export interface SerialRead {
  serial: string;
  /** Every line of text found alongside it — chiefly the card's printed name. */
  lines: string[];
}

/**
 * Reads the printed serial off a card in the frame, or returns null. `corners`
 * are the detector's (TL, TR, BR, BL, normalised). Injected so this service stays
 * free of native code; the app supplies the on-device recogniser.
 */
export type SerialReader = (game: GameId, frame: RgbaImage, corners: Point[]) => Promise<SerialRead | null>;

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
  /**
   * Reads the card's printed serial. When it yields one — for games that print
   * one — the serial is checked first and picks the card; the image match only
   * chooses between printings that share it.
   */
  serialReader?: SerialReader | null;
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

  /**
   * Identify a single, deliberately-captured photo (the manual shutter path).
   * Unlike the live path there is no steadiness gate and no multi-frame vote:
   * the user framed the card and tapped, so one good frame is the whole scan.
   * A frame with no visible card still comes back with a reason to show.
   */
  async scanImageOnce(
    frame: import('./image').RgbaImage,
    onStage?: (stage: string) => void,
  ): Promise<{ result: ScanResult | null; status: string }> {
    onStage?.('Detecting card…');
    // Let the status paint before the synchronous resize and tensor packing at
    // the start of detection hold the JS thread — otherwise the screen keeps
    // showing the previous step for the whole of it.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const processed = await this.pipeline.processFrame(frame);
    if (processed.rejected) {
      return { result: null, status: processed.rejected };
    }

    // The printed serial is the first thing to check, for the games that print
    // one: it names the card, where the picture match alone is weak on real
    // photos. Failing to read one is normal (glare, blur, an odd angle) and just
    // leaves the picture match to answer alone.
    let read: SerialRead | null = null;
    const reader = this.options.serialReader;
    if (reader && SERIAL_GAMES.has(this.options.gameId)) {
      onStage?.('Reading card number…');
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      try {
        read = await reader(this.options.gameId, frame, processed.detection.corners);
      } catch (error) {
        this.pipeline.trace?.(`serial: reader failed — ${(error as Error).message}`);
      }
      this.pipeline.trace?.(`serial: ${read?.serial ?? 'not read'}`);
    }

    onStage?.('Matching…');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    this.reset();
    this.frames.push(processed);
    const result = await this.finish(null, read);
    this.reset();
    return { result, status: 'done' };
  }

  /**
   * Settle a serial read off the card against the catalogue.
   *
   * The serial is misread a digit at a time often enough (OP17 read as OP12, a
   * real serial of another card) that it is not trusted alone: printings carrying
   * it or a serial one digit away are gathered, and the card's printed name and
   * the picture decide among them. The chosen serial's printings then come back
   * ranked, with how firmly the rest of the evidence backed it. Null when the
   * catalogue has nothing near the serial.
   */
  private async matchBySerial(
    read: SerialRead,
  ): Promise<{ serial: string; ranked: SerialMatch[]; choice: SerialChoice } | null> {
    const near = await printingsMatchingSerials(this.options.gameId, nearSerialPatterns(read.serial));
    this.pipeline.trace?.(`serial: ${read.serial} -> ${near.length} printing(s) at or near it`);
    if (near.length === 0) return null;

    const embedding = this.frames[this.frames.length - 1]?.embedding ?? null;
    const pack = this.pipeline.indexPack;
    const choice = chooseSerial(near, read.serial, read.lines, embedding, pack);
    if (!choice) return null;

    const ranked = rankPrintingsBySerial(
      near.filter((printing) => printing.number === choice.serial),
      choice.serial,
      embedding,
      pack,
    );
    this.pipeline.trace?.(
      `serial: chose ${choice.serial}${choice.exact ? '' : ` (read as ${read.serial})`} name=${choice.nameScore.toFixed(2)} picture=${choice.imageScore === null ? 'none' : choice.imageScore.toFixed(3)}`,
    );
    for (const match of ranked.slice(0, 4)) {
      this.pipeline.trace?.(
        `serial: ${match.printing.id} score=${match.score === null ? 'no index row' : match.score.toFixed(3)}${match.home ? ' (home set)' : ''}`,
      );
    }
    return { serial: choice.serial, ranked, choice };
  }

  /** Resolve the frames gathered so far into a result. */
  async finish(photoUri: string | null, read: SerialRead | null = null): Promise<ScanResult> {
    const started = Date.now();
    const voted = combineFrames(this.frames);

    const candidates = await this.expandCandidates(voted.candidates);

    // A readable serial that the catalogue knows decides the card.
    const bySerial = read ? await this.matchBySerial(read) : null;
    if (bySerial) {
      const { serial, ranked, choice } = bySerial;
      const serialPrintingIds = new Set(ranked.map((match) => match.printing.id));
      const others = candidates.filter((candidate) => !candidate.printings.some((p) => serialPrintingIds.has(p.id)));
      return {
        printing: ranked[0].printing,
        candidates: [
          { artId: `serial:${serial}`, score: ranked[0].score ?? 0, printings: ranked.map((match) => match.printing) },
          ...others,
        ],
        confidence: serialConfidence(serial, ranked, choice),
        parsedCorner: { setCode: serialSet(serial), number: serial, setTotal: null, language: null },
        printingScores: [],
        embedding: this.frames[this.frames.length - 1]?.embedding ?? null,
        frames: [...this.frames],
        timings: { totalMs: Date.now() - started },
      };
    }

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

    // Grade the match on distinct artworks. The raw index rows include one per
    // printing, so a card's runner-up is often just another printing of the same
    // art at nearly the same score, which would read as an ambiguous match.
    const confidence = assessConfidence({
      candidates: candidates.map((candidate, row) => ({ artId: candidate.artId, score: candidate.score, row })),
      frameCount: this.frames.filter((frame) => frame.candidates.length > 0).length,
      ocrAgrees: ocrAgreement(printingScores, chosen),
      // Not graded on the detector's sharpness head; see combineFrames.
      sharpness: null,
    });
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
    // Each candidate's `artId` is really the index row's id, which is a printing
    // id (see printingsForIndexRow). Several rows can share one artwork, so keep
    // the best row per artwork, and skip rows whose printing isn't in the local
    // catalogue (the index can be newer or older than the synced catalogue).
    const expanded: ScanCandidate[] = [];
    const seenArt = new Set<string>();
    for (const candidate of candidates) {
      if (expanded.length >= 5) break;
      const resolved = await printingsForIndexRow(candidate.artId);
      this.pipeline.trace?.(
        `match: ${candidate.artId} score=${candidate.score.toFixed(3)} -> ${
          resolved ? `${resolved.printings.length} printing(s)` : 'not in local catalogue'
        }`,
      );
      if (!resolved || seenArt.has(resolved.artId)) continue;
      seenArt.add(resolved.artId);
      expanded.push({ artId: resolved.artId, score: candidate.score, printings: resolved.printings });
    }
    return expanded;
  }
}
