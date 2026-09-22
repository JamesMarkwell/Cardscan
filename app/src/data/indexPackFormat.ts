/**
 * Fingerprint index pack.
 *
 * Format (little-endian), produced by /ml/build_index.py:
 *   magic   "CVIX"           4 bytes
 *   version uint32           format version, currently 1
 *   dtype   uint32           0 = float32, 1 = float16
 *   rows    uint32
 *   dim     uint32
 *   matrix  rows * dim values, row-major, each row L2-normalised
 * The ids live alongside in a newline-separated `.ids` file, aligned by row.
 */
import { IndexPack } from '../scan/search';

const MAGIC = 0x58495643; // "CVIX" little-endian
export const DTYPE_FLOAT32 = 0;
export const DTYPE_FLOAT16 = 1;

/** Decode IEEE-754 half precision. */
export function float16ToFloat32(bits: number): number {
  const sign = (bits & 0x8000) >> 15;
  const exponent = (bits & 0x7c00) >> 10;
  const fraction = bits & 0x03ff;

  let value: number;
  if (exponent === 0) value = fraction / 1024 / 16384;
  else if (exponent === 0x1f) value = fraction ? NaN : Infinity;
  else value = (1 + fraction / 1024) * Math.pow(2, exponent - 15);

  return sign ? -value : value;
}

export function parseIndexPack(buffer: ArrayBuffer, ids: string[], version: string): IndexPack {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('Not a CardScan index pack');

  const formatVersion = view.getUint32(4, true);
  if (formatVersion !== 1) throw new Error(`Unsupported index pack version ${formatVersion}`);

  const dtype = view.getUint32(8, true);
  const rows = view.getUint32(12, true);
  const dim = view.getUint32(16, true);
  const headerBytes = 20;

  const matrix = new Float32Array(rows * dim);
  if (dtype === DTYPE_FLOAT32) {
    for (let i = 0; i < matrix.length; i += 1) {
      matrix[i] = view.getFloat32(headerBytes + i * 4, true);
    }
  } else if (dtype === DTYPE_FLOAT16) {
    for (let i = 0; i < matrix.length; i += 1) {
      matrix[i] = float16ToFloat32(view.getUint16(headerBytes + i * 2, true));
    }
  } else {
    throw new Error(`Unsupported index dtype ${dtype}`);
  }

  if (ids.length !== rows) {
    throw new Error(`Index pack has ${rows} rows but ${ids.length} ids`);
  }

  return { matrix, ids, dim, version };
}
