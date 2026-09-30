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

/**
 * Keeping a phone's copy of an index pack current.
 *
 * The fingerprint job grows a version's pack in place as it embeds new cards, so
 * the pack behind a URL changes without the URL changing. The Worker serves an
 * ETag for it; the phone remembers the ETag of the copy it downloaded and fetches
 * again when the server's differs. These helpers are kept free of native code so
 * they can be tested.
 */

/** Whether the server's copy differs from the one held. No answer from the server means keep what we have. */
export function isIndexStale(stored: string | null, remote: string | null): boolean {
  return remote !== null && remote !== stored;
}

/** The server's ETag for a pack, or null if it cannot be read. */
export async function remoteIndexEtag(url: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const response = await fetchFn(url, { method: 'HEAD' });
  return response.ok ? response.headers.get('etag') : null;
}

/**
 * The URL with the ETag added as a query parameter. The server ignores it; it
 * makes a changed pack a different URL, so no HTTP cache anywhere can hand back
 * the old copy.
 */
export function withVersionParam(url: string, etag: string | null): string {
  if (!etag) return url;
  return `${url}${url.includes('?') ? '&' : '?'}e=${encodeURIComponent(etag)}`;
}

/** Rows a pack's header says it holds. */
export function packRowCount(bytes: Uint8Array): number {
  if (bytes.byteLength < 20) throw new Error('Index pack is truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('Not a CardScan index pack');
  return view.getUint32(12, true);
}

/**
 * Check a downloaded pack and its ids belong together. They are two files
 * fetched a moment apart, and if the job replaced them in between the pair would
 * disagree and the pack would not load — so a mismatch must be caught before the
 * copy is recorded as current.
 */
export function assertPackMatchesIds(bytes: Uint8Array, idsText: string): void {
  const rows = packRowCount(bytes);
  const ids = idsText.split('\n').filter((line) => line.trim().length > 0).length;
  if (rows !== ids) throw new Error(`Index pack has ${rows} rows but ${ids} ids`);
}
