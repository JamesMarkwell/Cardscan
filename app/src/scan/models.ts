/**
 * Model loading.
 *
 * Cornelius (corner detector) and Milo (embedder) are CollectorVision's
 * published ONNX models, bundled unchanged — see docs/THIRD_PARTY.md. They ship
 * inside the app so the first scan works with no network.
 */
import { Asset } from 'expo-asset';
import { Directory, File, Paths } from 'expo-file-system';
import { InferenceSession, loadOrt } from './ort';

export interface ModelSpec {
  name: string;
  version: string;
  inputSize: number;
  module: number;
}

// Metadata mirrors collector_vision/weights/__init__.py at the pinned version.
export const CORNELIUS: ModelSpec = {
  name: 'cornelius',
  version: '2.12',
  inputSize: 384,
  module: require('../../assets/models/cornelius.onnx'),
};

export const MILO: ModelSpec = {
  name: 'milo',
  version: '1.0.0',
  inputSize: 448,
  module: require('../../assets/models/milo.onnx'),
};

/** ONNX Runtime wants a plain path, not a file:// URI. */
function toNativePath(uri: string): string {
  return uri.startsWith('file://') ? decodeURI(uri.slice('file://'.length)) : uri;
}

/**
 * Bundled assets live inside the APK, where ORT cannot open them, so each model
 * is unpacked into the document directory once and reused afterwards.
 */
export async function ensureModelFile(spec: ModelSpec): Promise<string> {
  const directory = new Directory(Paths.document, 'models');
  if (!directory.exists) directory.create({ intermediates: true });

  const target = new File(directory, `${spec.name}-${spec.version}.onnx`);
  if (target.exists && (target.size ?? 0) > 0) return toNativePath(target.uri);

  const asset = Asset.fromModule(spec.module);
  await asset.downloadAsync();
  if (!asset.localUri) throw new Error(`Could not unpack model ${spec.name}`);

  await new File(asset.localUri).copy(target);
  return toNativePath(target.uri);
}

export async function createSession(spec: ModelSpec): Promise<InferenceSession> {
  const path = await ensureModelFile(spec);
  const ort = await loadOrt();
  return ort.InferenceSession.create(path, {
    // NNAPI where the device supports it, XNNPACK/CPU otherwise. ONNX Runtime
    // falls back on its own when a provider is unavailable.
    executionProviders: ['nnapi', 'xnnpack', 'cpu'],
    graphOptimizationLevel: 'all',
  });
}
