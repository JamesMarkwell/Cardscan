/**
 * ONNX Runtime access for the scan pipeline.
 *
 * Backed by the local `expo-onnx` native module (Expo Modules API, New
 * Architecture / bridgeless native), which wraps the official onnxruntime-android
 * AAR. This replaces onnxruntime-react-native, whose legacy-bridge native code
 * crashed the app at startup on React Native 0.86 — Expo SDK 57 mandates the New
 * Architecture, which that library does not support.
 *
 * The surface here (InferenceSession, Tensor) matches how models.ts and
 * pipeline.ts already use it, so nothing above this file had to change.
 */
import { requireNativeModule } from 'expo-modules-core';
import type { NativeOnnx } from '../../modules/expo-onnx/src';

// Resolved lazily so importing this file off-device (tests, tooling) does not
// require the native module to be present.
let native: NativeOnnx | null = null;
function nativeModule(): NativeOnnx {
  if (!native) native = requireNativeModule('ExpoOnnx') as NativeOnnx;
  return native;
}

/** Feeds and outputs are single-input/keyed by name, matching the models here. */
export class Tensor {
  constructor(
    public readonly type: 'float32',
    public readonly data: Float32Array,
    public readonly dims: number[],
  ) {}
}

export interface RunResult {
  [name: string]: { data: Float32Array; dims: number[] };
}

export class InferenceSession {
  private constructor(
    private readonly id: string,
    readonly inputNames: string[],
    readonly outputNames: string[],
  ) {}

  /** Load a model file and cache its input/output names for synchronous access. */
  static async create(path: string): Promise<InferenceSession> {
    const onnx = nativeModule();
    const id = await onnx.create(path);
    const [inputNames, outputNames] = await Promise.all([onnx.inputNames(id), onnx.outputNames(id)]);
    return new InferenceSession(id, inputNames, outputNames);
  }

  async run(feeds: Record<string, Tensor>): Promise<RunResult> {
    const entries = Object.entries(feeds);
    if (entries.length === 0) throw new Error('run() needs one input tensor');
    const [name, tensor] = entries[0];

    const raw = await nativeModule().run(this.id, name, tensor.data, tensor.dims, this.outputNames);
    const result: RunResult = {};
    for (const key of Object.keys(raw)) {
      result[key] = { data: Float32Array.from(raw[key].data), dims: raw[key].dims };
    }
    return result;
  }

  async release(): Promise<void> {
    await nativeModule().release(this.id);
  }
}
