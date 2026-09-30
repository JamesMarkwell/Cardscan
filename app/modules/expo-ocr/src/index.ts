// Local Expo module: on-device text recognition (ML Kit). See android/ for the
// native implementation. The scan pipeline uses this through src/scan/serialOcr.ts.
import { requireNativeModule } from 'expo-modules-core';

export interface NativeOcr {
  /** Packed ARGB pixels (row-major) in, the recognised lines out. */
  recognise(pixels: number[], width: number, height: number): Promise<string[]>;
}

export default requireNativeModule('ExpoOcr') as NativeOcr;
