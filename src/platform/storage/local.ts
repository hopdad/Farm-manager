/**
 * Local storage adapter (contracts §10): objects live at `<root>/<bucket>/<key>`, root =
 * `path.resolve(cfg.projectDir, cfg.STORAGE_DIR)` (default `.data/storage`, gitignored).
 * Read side only in M0. Only src/platform/** touches the filesystem for storage (plan §1).
 *
 * Path safety, twice: keys go through parseStorageKey (no `..`, backslashes, drive letters, …),
 * then the resolved path must stay under `<root>/<bucket>/`, and so must its real path (a
 * symlink inside the bucket can't point outside it).
 */
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Config } from '../../config';
import { parseStorageKey, type StorageBucket } from './keys';
import type { ByteRange, StorageObjectInfo, StorageReader } from './types';

const DEFAULT_MAX_TEXT_BYTES = 1024 * 1024;

export class StorageNotFoundError extends Error {
  constructor(bucket: string, key: string) {
    super(`storage object not found: ${bucket}/${key}`);
    this.name = 'StorageNotFoundError';
  }
}

/**
 * Is `child` strictly inside `dir`? Both absolute. `platform` picks the path rules (separator,
 * case-insensitive on Windows), so the check is the same whatever OS runs it.
 */
export function isInside(dir: string, child: string, platform = process.platform): boolean {
  const win = platform === 'win32';
  const sep = win ? path.win32.sep : path.posix.sep;
  const norm = (p: string) => (win ? p.toLowerCase() : p);
  const base = norm(dir.endsWith(sep) ? dir : dir + sep);
  return norm(child).startsWith(base) && norm(child).length > base.length;
}

export class LocalStorage implements StorageReader {
  /** Absolute storage root. */
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Absolute directory of a bucket. */
  bucketDir(bucket: StorageBucket): string {
    return path.join(this.root, bucket);
  }

  /** Absolute path of an object. Throws StorageKeyError for a bad key or an escaping path. */
  pathOf(bucket: StorageBucket, key: string): string {
    const normalized = parseStorageKey(key);
    const dir = this.bucketDir(bucket);
    const full = path.resolve(dir, ...normalized.split('/'));
    if (!isInside(dir, full)) throw new Error(`key escapes bucket: ${key}`);
    return full;
  }

  /** Real path of an existing object, checked against the bucket's real path; null if missing. */
  private async realPathOf(bucket: StorageBucket, key: string): Promise<string | null> {
    const full = this.pathOf(bucket, key);
    let realDir: string;
    let realFull: string;
    try {
      realDir = await realpath(this.bucketDir(bucket));
      realFull = await realpath(full);
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
    if (!isInside(realDir, realFull)) return null;
    return realFull;
  }

  async stat(bucket: StorageBucket, key: string): Promise<StorageObjectInfo | null> {
    const real = await this.realPathOf(bucket, key);
    if (!real) return null;
    const s = await stat(real);
    if (!s.isFile()) return null;
    return { bucket, key: parseStorageKey(key), size: s.size, mtime: s.mtime };
  }

  async openRead(bucket: StorageBucket, key: string, range?: ByteRange): Promise<Readable> {
    const real = await this.realPathOf(bucket, key);
    if (!real) throw new StorageNotFoundError(bucket, key);
    return createReadStream(real, range ? { start: range.start, end: range.end } : {});
  }

  async readText(
    bucket: StorageBucket,
    key: string,
    maxBytes = DEFAULT_MAX_TEXT_BYTES,
  ): Promise<string | null> {
    const info = await this.stat(bucket, key);
    if (!info) return null;
    if (info.size > maxBytes) {
      throw new Error(`${bucket}/${key} is ${info.size} bytes (limit ${maxBytes} for readText)`);
    }
    const real = await this.realPathOf(bucket, key);
    if (!real) return null;
    return readFile(real, 'utf8');
  }
}

function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Storage root for a config (contracts §10). */
export function storageRoot(cfg: Pick<Config, 'projectDir' | 'STORAGE_DIR'>): string {
  return path.resolve(cfg.projectDir, cfg.STORAGE_DIR);
}
