// DIAGNOSTIC STUB — not for production. See metro.config.js.
//
// Replaces onnxruntime-react-native in the JS bundle so the app builds and runs
// with the real native module entirely absent from the APK. Bisects the launch
// crash: if the app launches with this stub (dependency removed from
// package.json, so its native library and startup init are gone from the APK),
// ONNX Runtime's native side is the cause.

export class Tensor {
  constructor(public type: string, public data: unknown, public dims: number[]) {}
}

export class InferenceSession {
  static async create(..._args: unknown[]): Promise<InferenceSession> {
    throw new Error('ONNX Runtime is stubbed out in this diagnostic build');
  }
  get inputNames(): string[] {
    return [];
  }
  get outputNames(): string[] {
    return [];
  }
  async run(..._args: unknown[]): Promise<Record<string, { data: Float32Array }>> {
    throw new Error('ONNX Runtime is stubbed out in this diagnostic build');
  }
  async release(): Promise<void> {}
}
