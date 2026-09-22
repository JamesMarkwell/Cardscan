/**
 * Lazy loader for onnxruntime-react-native.
 *
 * The library runs `Module.install()` at import time (its binding.js), and that
 * is a blocking synchronous call into a legacy native module. React Native 0.86
 * is bridgeless, where that call is rejected, and because ONNX Runtime sits at
 * the top of the app's module graph the failure happens during initial bundle
 * evaluation -- before React mounts, so nothing can catch it and the app closes
 * instantly with no error screen.
 *
 * Loading it lazily moves that evaluation to the moment scanning actually
 * starts, after the UI is up, and inside a try/catch. A failure then surfaces as
 * an error on the scan screen instead of taking the whole app down. The models
 * only load when the user opens the scanner, so nothing is lost by deferring.
 */

// Types only: `import type` is erased at compile time and adds no runtime
// require, so this does not pull ONNX Runtime into the startup path.
import type { InferenceSession as OrtInferenceSession, Tensor as OrtTensor } from 'onnxruntime-react-native';

export type InferenceSession = OrtInferenceSession;
export type Tensor = OrtTensor;

type OrtModule = typeof import('onnxruntime-react-native');

let loaded: OrtModule | null = null;
let failure: Error | null = null;

/**
 * Load ONNX Runtime, evaluating its module body (and its install() call) now
 * rather than at app start. Caches success and failure so it is attempted once.
 */
export async function loadOrt(): Promise<OrtModule> {
  if (loaded) return loaded;
  if (failure) throw failure;
  try {
    loaded = await import('onnxruntime-react-native');
    return loaded;
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    throw failure;
  }
}
