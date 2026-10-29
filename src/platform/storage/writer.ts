/**
 * The storage adapter's write side (docs/contracts-m1.md §9; contract: ./types.ts StorageWriter).
 * Local version: `.data/storage/<bucket>/<key>`, the same tree the reader (./local.ts) serves.
 *
 *  - Uploads from browsers are two-step: a route handler checks the session and calls
 *    `createUploadGrant`, which returns `/api/storage/<bucket>/<key>?exp&max&ct&sig` (HMAC with
 *    SESSION_SECRET, ./signing.ts); the browser PUTs the bytes there and the route's PUT handler
 *    (./upload.ts) streams them into `put()` with the grant's byte limit.
 *  - Tools on the PC (gis:*, import:*) call `put()` directly: no size cap (PMTiles are big).
 *  - NO overwrites in any bucket (BUCKET_RULES): identical bytes at an existing key are a no-op
 *    (a retried upload); different bytes are a StorageConflictError. A content-addressed key
 *    (`name.<sha8>.ext`) must hold bytes whose sha256 starts with that sha8.
 *  - Atomic: bytes stream into `<root>/.tmp/` (outside every bucket, so the read route can never
 *    serve a half-written file), then a hard link creates the key only if it doesn't exist yet
 *    (two writers racing for one key: exactly one wins, the other compares). On a filesystem
 *    without hard links it falls back to check-then-rename.
 *
 * Only src/platform/** touches the filesystem for storage (plan §1). `getStorageWriter()` is a
 * globalThis singleton like `getStorage()`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getConfig } from '../../config';
import { contentTypeFor } from './content-type';
import {
  contentHashOf,
  isStorageBucket,
  parseStorageKey,
  type StorageBucket,
  StorageKeyError,
} from './keys';
import { isInside, LocalStorage, storageRoot } from './local';
import { expiryAfter, normalizeContentType, signStorageClaims } from './signing';
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_GRANT_SECONDS,
  type PutOptions,
  StorageConflictError,
  type StorageObjectInfo,
  StorageTooLargeError,
  type StorageWriter,
  type UploadGrant,
  type UploadGrantRequest,
} from './types';

/** Longest a signed read URL may live (Supabase allows any; a week keeps leaked links short-lived). */
export const MAX_SIGNED_READ_SECONDS = 7 * 24 * 60 * 60;

/** Directory under the storage root for in-flight writes (not a bucket: never served). */
export const TMP_DIR = '.tmp';

/**
 * Types a browser upload may declare. SVG is refused: served from the app's origin it could run
 * script. Everything else is served as `contentTypeFor(key)` with nosniff, and a grant requires
 * the declared type to be exactly that (the object is later served as what was granted).
 */
export const REFUSED_UPLOAD_TYPES: readonly string[] = ['image/svg+xml'];

/** A content-addressed key whose sha8 doesn't match its bytes. HTTP 400. */
export class StorageHashMismatchError extends Error {
  constructor(key: string, actual: string) {
    super(`content of ${key} hashes to ${actual.slice(0, 8)}, not the key's hash`);
    this.name = 'StorageHashMismatchError';
  }
}

/** put() with the details the HTTP PUT handler needs. */
export interface PutResult {
  info: StorageObjectInfo;
  /** False when identical bytes were already there (a retried upload). */
  created: boolean;
  sha256: string;
}

export interface InternalPutOptions extends PutOptions {
  /** Refuse (StorageTooLargeError) once more than this many bytes arrive. */
  maxBytes?: number;
}

/** Counts and hashes bytes on their way to disk; errors once past `limit`. */
class Meter extends Transform {
  bytes = 0;
  readonly hash = createHash('sha256');
  constructor(private readonly limit: number) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      cb(new StorageTooLargeError(this.limit));
      return;
    }
    this.hash.update(chunk);
    cb(null, chunk);
  }
}

async function sha256OfFile(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

function errnoCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

/** Link-unsupported errors (FAT/exFAT, some network shares): fall back to check-then-rename. */
const NO_LINK_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL']);

export interface LocalStorageWriterOptions {
  /** Clock for grant and signed-URL expiry (tests). */
  now?: () => Date;
}

export class LocalStorageWriter extends LocalStorage implements StorageWriter {
  private readonly secret: string;
  private readonly now: () => Date;

  constructor(root: string, secret: string, opts: LocalStorageWriterOptions = {}) {
    super(root);
    if (secret.length < 32)
      throw new Error('storage signing secret must be at least 32 characters');
    this.secret = secret;
    this.now = opts.now ?? (() => new Date());
  }

  async createUploadGrant(req: UploadGrantRequest): Promise<UploadGrant> {
    if (!isStorageBucket(req.bucket)) throw new StorageKeyError(`unknown bucket '${req.bucket}'`);
    const key = parseStorageKey(req.key);
    const contentType = normalizeContentType(req.contentType);
    const served = normalizeContentType(contentTypeFor(key));
    if (REFUSED_UPLOAD_TYPES.includes(contentType)) {
      throw new RangeError(`uploads of ${contentType} are not allowed`);
    }
    if (contentType !== served) {
      throw new RangeError(
        `content type '${contentType}' does not match the key's extension ('${served}')`,
      );
    }
    if (!Number.isSafeInteger(req.bytes) || req.bytes < 1) {
      throw new RangeError('bytes must be a positive integer');
    }
    if (req.bytes > MAX_UPLOAD_BYTES) throw new StorageTooLargeError(MAX_UPLOAD_BYTES);
    const seconds = req.expiresInSeconds ?? MAX_UPLOAD_GRANT_SECONDS;
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_UPLOAD_GRANT_SECONDS) {
      throw new RangeError(`expiresInSeconds must be 1..${MAX_UPLOAD_GRANT_SECONDS}`);
    }
    if (await this.stat(req.bucket, key)) throw new StorageConflictError(req.bucket, key);

    const now = this.now();
    const expires = expiryAfter(now, seconds);
    const q = signStorageClaims(this.secret, {
      method: 'PUT',
      bucket: req.bucket,
      key,
      expires,
      maxBytes: req.bytes,
      contentType,
    });
    return {
      bucket: req.bucket,
      key,
      method: 'PUT',
      url: `${this.publicUrl(req.bucket, key)}?${q.toString()}`,
      headers: { 'content-type': contentType },
      expiresAt: new Date(expires * 1000).toISOString(),
      maxBytes: req.bytes,
    };
  }

  async createSignedReadUrl(
    bucket: StorageBucket,
    key: string,
    expiresInSeconds: number,
  ): Promise<string> {
    if (!isStorageBucket(bucket)) throw new StorageKeyError(`unknown bucket '${bucket}'`);
    const normalized = parseStorageKey(key);
    if (
      !Number.isSafeInteger(expiresInSeconds) ||
      expiresInSeconds < 1 ||
      expiresInSeconds > MAX_SIGNED_READ_SECONDS
    ) {
      throw new RangeError(`expiresInSeconds must be 1..${MAX_SIGNED_READ_SECONDS}`);
    }
    const q = signStorageClaims(this.secret, {
      method: 'GET',
      bucket,
      key: normalized,
      expires: expiryAfter(this.now(), expiresInSeconds),
    });
    return `${this.publicUrl(bucket, normalized)}?${q.toString()}`;
  }

  async put(
    bucket: StorageBucket,
    key: string,
    body: Readable | Uint8Array,
    opts: PutOptions = {},
  ): Promise<StorageObjectInfo> {
    return (await this.putObject(bucket, key, body, opts)).info;
  }

  /** put() that also says whether it created the object, and enforces an optional byte limit. */
  async putObject(
    bucket: StorageBucket,
    key: string,
    body: Readable | Uint8Array,
    opts: InternalPutOptions = {},
  ): Promise<PutResult> {
    if (!isStorageBucket(bucket)) throw new StorageKeyError(`unknown bucket '${bucket}'`);
    const normalized = parseStorageKey(key);
    const dest = this.pathOf(bucket, normalized);
    const source = body instanceof Uint8Array ? Readable.from([Buffer.from(body)]) : body;

    const tmpDir = path.join(this.root, TMP_DIR);
    await mkdir(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `${randomUUID()}.part`);
    const meter = new Meter(opts.maxBytes ?? Number.MAX_SAFE_INTEGER);
    try {
      await pipeline(source, meter, createWriteStream(tmp, { flags: 'wx' }));
      const sha256 = meter.hash.digest('hex');
      const sha8 = contentHashOf(normalized);
      if (sha8 && !sha256.startsWith(sha8)) throw new StorageHashMismatchError(normalized, sha256);

      await this.ensureParentDir(bucket, dest);
      const created = await this.commit(tmp, dest, meter.bytes, sha256, bucket, normalized);
      const info = await this.stat(bucket, normalized);
      if (!info) throw new Error(`stored object vanished: ${bucket}/${normalized}`);
      return { info, created, sha256 };
    } catch (e) {
      // Destroy a still-flowing source so a request body isn't read any further.
      if (!(body instanceof Uint8Array) && !source.destroyed) source.destroy();
      throw e;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async delete(bucket: StorageBucket, key: string): Promise<boolean> {
    if (!isStorageBucket(bucket)) throw new StorageKeyError(`unknown bucket '${bucket}'`);
    const normalized = parseStorageKey(key);
    if (!(await this.stat(bucket, normalized))) return false;
    try {
      await unlink(this.pathOf(bucket, normalized));
      return true;
    } catch (e) {
      if (errnoCode(e) === 'ENOENT') return false;
      throw e;
    }
  }

  /** mkdir -p the object's directory and check its real path stays inside the bucket. */
  private async ensureParentDir(bucket: StorageBucket, dest: string): Promise<void> {
    const bucketDir = this.bucketDir(bucket);
    await mkdir(path.dirname(dest), { recursive: true });
    const realBucket = await realpath(bucketDir);
    const realParent = await realpath(path.dirname(dest));
    if (realParent !== realBucket && !isInside(realBucket, realParent)) {
      throw new StorageKeyError('key escapes its bucket through a link');
    }
  }

  /** Create `dest` from `tmp` unless it exists; true = created, false = identical already. */
  private async commit(
    tmp: string,
    dest: string,
    bytes: number,
    sha256: string,
    bucket: StorageBucket,
    key: string,
  ): Promise<boolean> {
    try {
      await link(tmp, dest);
      return true;
    } catch (e) {
      const code = errnoCode(e);
      if (code === 'EEXIST') return this.sameAsExisting(dest, bytes, sha256, bucket, key);
      if (!code || !NO_LINK_CODES.has(code)) throw e;
    }
    // No hard links here: check, then rename (a tiny race, acceptable on the single PC).
    const existing = await stat(dest).catch(() => null);
    if (existing) return this.sameAsExisting(dest, bytes, sha256, bucket, key);
    await rename(tmp, dest);
    return true;
  }

  private async sameAsExisting(
    dest: string,
    bytes: number,
    sha256: string,
    bucket: StorageBucket,
    key: string,
  ): Promise<false> {
    const s = await stat(dest);
    if (!s.isFile() || s.size !== bytes || (await sha256OfFile(dest)) !== sha256) {
      throw new StorageConflictError(bucket, key);
    }
    return false;
  }
}

const g = globalThis as typeof globalThis & { __farmStorageWriter?: LocalStorageWriter };

/**
 * The local writer itself: the /api/storage PUT handler needs `putObject` (byte limit, created
 * flag). That route exists only for the local adapter; at MD browsers PUT straight to Supabase.
 */
export function getLocalStorageWriter(): LocalStorageWriter {
  if (!g.__farmStorageWriter) {
    const cfg = getConfig();
    g.__farmStorageWriter = new LocalStorageWriter(storageRoot(cfg), cfg.SESSION_SECRET);
  }
  return g.__farmStorageWriter;
}

/** The write side for this environment (local filesystem now; Supabase Storage at MD). */
export function getStorageWriter(): StorageWriter {
  return getLocalStorageWriter();
}
