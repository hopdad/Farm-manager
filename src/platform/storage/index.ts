/**
 * Storage entry point. `getStorage()` returns the adapter for this environment: the local
 * filesystem adapter in M0 (Supabase Storage at MD, behind the same StorageReader interface).
 * A globalThis singleton so `next dev` hot reloads don't create one per module instance.
 */
import { getConfig } from '../../config';
import { LocalStorage, storageRoot } from './local';
import type { StorageReader } from './types';

export type { BasemapManifest, BasemapStatus } from './basemap';
export { readBasemapStatus } from './basemap';
export type { StorageBucket } from './keys';
export type { ByteRange, StorageObjectInfo, StorageReader } from './types';

const g = globalThis as typeof globalThis & { __farmStorage?: StorageReader };

export function getStorage(): StorageReader {
  if (!g.__farmStorage) g.__farmStorage = new LocalStorage(storageRoot(getConfig()));
  return g.__farmStorage;
}
