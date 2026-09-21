/** Index pack storage: where packs live on the device and how they are fetched. */
import { Directory, File, Paths } from 'expo-file-system';
import { IndexPack } from '../scan/search';
import { parseIndexPack } from './indexPackFormat';

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

export async function loadIndexPack(gameId: string, version: string): Promise<IndexPack | null> {
  const { pack, ids } = indexFiles(gameId, version);
  if (!pack.exists || !ids.exists) return null;

  const bytes = await pack.bytes();
  const idList = (await ids.text()).split('\n').map((line) => line.trim()).filter(Boolean);
  return parseIndexPack(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, idList, version);
}

export async function saveIndexPack(gameId: string, version: string, packUrl: string, idsUrl: string): Promise<void> {
  const { pack, ids } = indexFiles(gameId, version);
  await File.downloadFileAsync(packUrl, pack, { idempotent: true });
  await File.downloadFileAsync(idsUrl, ids, { idempotent: true });
}
