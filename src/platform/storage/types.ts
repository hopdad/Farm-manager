/**
 * Storage adapter contract (plan §1 "Storage", contracts §10). Read side only in M0: the local
 * adapter (./local.ts) serves `.data/storage/<bucket>/<key>`; Supabase Storage replaces it at MD.
 * Signed URLs and two-step PUT (4 MB limit, `tiles` never overwritten) arrive in 1d/2c.
 */
import type { Readable } from 'node:stream';
import type { StorageBucket } from './keys';

export interface StorageObjectInfo {
  bucket: StorageBucket;
  /** Normalized key (see parseStorageKey). */
  key: string;
  /** Size in bytes. */
  size: number;
  /** Last modification time. */
  mtime: Date;
}

export interface ByteRange {
  /** First byte, inclusive. */
  start: number;
  /** Last byte, inclusive. */
  end: number;
}

export interface StorageReader {
  /** Object metadata, or null when it doesn't exist (or isn't a regular file). */
  stat(bucket: StorageBucket, key: string): Promise<StorageObjectInfo | null>;
  /** Stream the object (or one byte range of it). Throws when it doesn't exist. */
  openRead(bucket: StorageBucket, key: string, range?: ByteRange): Promise<Readable>;
  /** Read a small object as UTF-8 text (refuses objects over `maxBytes`, default 1 MiB). */
  readText(bucket: StorageBucket, key: string, maxBytes?: number): Promise<string | null>;
  /**
   * The URL a browser fetches the object (or, for a key prefix, the objects under it) from:
   * locally `/api/storage/<bucket>/<key>` (segments URL-encoded); at MD the Supabase adapter
   * returns the public `tiles` bucket's object URL, so PMTiles Range requests, glyphs and
   * sprites never go through an app function. Absolute or root-relative.
   */
  publicUrl(bucket: StorageBucket, key: string): string;
}
