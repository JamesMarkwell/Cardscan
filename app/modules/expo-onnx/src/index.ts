// Local Expo module: on-device ONNX Runtime inference. See android/ for the
// native implementation. The scan pipeline uses this through src/scan/ort.ts.
import { requireNativeModule } from 'expo-modules-core';

export interface NativeOnnxOutput {
  data: number[];
  dims: number[];
}

export interface NativeOnnx {
  create(path: string): Promise<string>;
  inputNames(id: string): Promise<string[]>;
  outputNames(id: string): Promise<string[]>;
  run(
    id: string,
    inputName: string,
    // A plain array, not a Float32Array: Expo's native converter for a Kotlin
    // FloatArray parameter only accepts a JS array and rejects a typed array.
    data: number[],
    dims: number[],
    outputNames: string[],
  ): Promise<Record<string, NativeOnnxOutput>>;
  release(id: string): Promise<void>;
}

export default requireNativeModule('ExpoOnnx') as NativeOnnx;
