/** Index pack storage: where packs live on the device and how they are fetched. */
import { Directory, File, Paths } from 'expo-file-system';
import { IndexPack } from '../scan/search';
import {
  assertPackMatchesIds,
  isIndexStale,
  parseIndexPack,
  remoteIndexEtag,
  withVersionParam,
} from './indexPackFormat';

export { DTYPE_FLOAT16, DTYPE_FLOAT32, float16ToFloat32, parseIndexPack } from './indexPackFormat';

function indexDirectory(): Directory {
  const directory = new Directory(Paths.document, 'index');
  if (!directory.exists) directory.create({ intermediates: true });
  return directory;
}

export function indexFiles(gameId: string, version: string): { pack: File; ids: File } {
  const directory = indexDirectory();
  return {
    pack: new File(directory, `${gameId}-${version}.bin`),
    ids: new File(directory, `${gameId}-${version}.ids`),
  };
}

/** Whether both files of a game's index pack are already on the device. */
export function indexPackExists(gameId: string, version: string): boolean {
  const { pack, ids } = indexFiles(gameId, version);
  return pack.exists && ids.exists;
}

export async function loadIndexPack(gameId: string, version: string): Promise<IndexPack | null> {
  const { pack, ids } = indexFiles(gameId, version);
  if (!pack.exists || !ids.exists) return null;

  const bytes = await pack.bytes();
  const idList = (await ids.text()).split('\n').map((line) => line.trim()).filter(Boolean);
  return parseIndexPack(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, idList, version);
}

/** The ETag of the pack copy on this device, or null if none was recorded. */
function storedIndexEtag(gameId: string, version: string): string | null {
  try {
    const file = new File(indexDirectory(), `${gameId}-${version}.etag`);
    return file.exists ? file.textSync().trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * Whether the pack should be (re)downloaded: it is missing, or the server's copy
 * has changed since ours was fetched. The fingerprint job adds cards to a
 * version's pack in place, so having a pack for a version does not mean having
 * the current one. Offline, or with no answer from the server, keep what we have.
 * A pack downloaded before ETags were recorded is fetched once more.
 */
export async function indexPackNeedsDownload(gameId: string, version: string, packUrl: string): Promise<boolean> {
  if (!indexPackExists(gameId, version)) return true;
  try {
    return isIndexStale(storedIndexEtag(gameId, version), await remoteIndexEtag(packUrl));
  } catch {
    return false;
  }
}

export async function saveIndexPack(gameId: string, version: string, packUrl: string, idsUrl: string): Promise<void> {
  const { pack, ids } = indexFiles(gameId, version);
  const etag = await remoteIndexEtag(packUrl).catch(() => null);

  await File.downloadFileAsync(withVersionParam(packUrl, etag), pack, { idempotent: true });
  await File.downloadFileAsync(withVersionParam(idsUrl, etag), ids, { idempotent: true });

  // Only record the copy as current if the pair is consistent; otherwise the next
  // sync fetches it again rather than trusting a torn download.
  assertPackMatchesIds(await pack.bytes(), await ids.text());
  const etagFile = new File(indexDirectory(), `${gameId}-${version}.etag`);
  if (etag) {
    if (!etagFile.exists) etagFile.create({ intermediates: true, overwrite: true });
    etagFile.write(etag);
  } else if (etagFile.exists) {
    etagFile.delete();
  }
}
