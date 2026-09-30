/**
 * The one call into the native text recogniser, with a timeout.
 *
 * Kept apart from serialOcr.ts so that file's logic can be tested without the
 * native module: this is the only place `expo-ocr` is required, and it is
 * required lazily.
 */
import { requireNativeModule } from 'expo-modules-core';
import type { NativeOcr } from '../../modules/expo-ocr/src';

// Recognition of a strip this size takes a fraction of a second. One that has not
// come back by now is stuck, so fail readably instead of spinning.
const RECOGNISE_TIMEOUT_MS = 15_000;

let native: NativeOcr | null = null;
function nativeModule(): NativeOcr {
  if (!native) native = requireNativeModule('ExpoOcr') as NativeOcr;
  return native;
}

/** Recognise the text in packed ARGB pixels; resolves with the lines found. */
export function requestNative(pixels: number[], width: number, height: number): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`text recognition timed out after ${RECOGNISE_TIMEOUT_MS / 1000}s`)),
      RECOGNISE_TIMEOUT_MS,
    );
    nativeModule()
      .recognise(pixels, width, height)
      .then(
        (lines) => {
          clearTimeout(timer);
          resolve(lines);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}
