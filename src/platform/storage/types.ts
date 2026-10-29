/**
 * Storage adapter contract (plan §1 "Storage", contracts §10). Read side since M0: the local
 * adapter (./local.ts) serves `.data/storage/<bucket>/<key>`; Supabase Storage replaces it at MD.
 * Write side (signed PUT grants, 4 MB uploads, no overwrites): `StorageWriter` below (1d).
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

// ---------------------------------------------------------------------------------------------
// Write side (M1 1d; implementation: imagery builder, new files under src/platform/storage/,
// entry point `getStorageWriter()` in ./writer.ts). docs/contracts-m1.md §9.
//
// Uploads are always two-step (plan §1): the server checks the session and hands out a grant
// (a short-lived signed PUT URL), then the browser PUTs the bytes straight to storage, never
// through an app function. Locally the URL is /api/storage/<bucket>/<key>?… (HMAC-signed with
// SESSION_SECRET, checked by that route's PUT handler); at MD it is Supabase Storage's
// createSignedUploadUrl. Tools on the PC (gis:*, import:*) write with `put()`.
// ---------------------------------------------------------------------------------------------

/** Largest upload a grant allows: the 4 MB request limit (plan §1). Bigger files are CLI-only. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Longest a grant lives (Supabase signed upload URLs last 2 hours). */
export const MAX_UPLOAD_GRANT_SECONDS = 2 * 60 * 60;

/**
 * Per-bucket rules. NO bucket overwrites: a PUT or put() to an existing key succeeds only when
 * the bytes are identical (a retried upload), else StorageConflictError / HTTP 409. `tiles` is
 * public and content-addressed (`name.<sha8>.ext`); `uploads` is private (signed GET only).
 */
export const BUCKET_RULES = {
  tiles: { public: true, overwrite: false },
  uploads: { public: false, overwrite: false },
} as const satisfies Record<StorageBucket, { public: boolean; overwrite: false }>;

export interface UploadGrantRequest {
  bucket: StorageBucket;
  /** Validated with parseStorageKey. */
  key: string;
  /** The Content-Type the PUT must send (e.g. 'image/jpeg'). */
  contentType: string;
  /** Declared size; refused over MAX_UPLOAD_BYTES. The PUT may not send more. */
  bytes: number;
  /** Default and maximum MAX_UPLOAD_GRANT_SECONDS. */
  expiresInSeconds?: number;
}

export interface UploadGrant {
  bucket: StorageBucket;
  key: string;
  method: 'PUT';
  /** Absolute or origin-relative; the browser PUTs the raw bytes here. */
  url: string;
  /** Headers the PUT must carry (at least content-type). */
  headers: Record<string, string>;
  /** UTC ISO. */
  expiresAt: string;
  maxBytes: number;
}

export interface PutOptions {
  contentType?: string;
}

/** The key already holds different bytes (no bucket overwrites). HTTP 409. */
export class StorageConflictError extends Error {
  constructor(bucket: string, key: string) {
    super(`storage key already exists with different content: ${bucket}/${key}`);
    this.name = 'StorageConflictError';
  }
}

/** Over the grant's or the bucket's size limit. HTTP 413. */
export class StorageTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`upload over ${limit} bytes`);
    this.name = 'StorageTooLargeError';
    this.limit = limit;
  }
}

/** The reader plus the write side. Same interface locally and at MD. */
export interface StorageWriter extends StorageReader {
  /**
   * Step 1 of an upload: a grant for one key. Call it from a route handler or server action
   * after requireRole(...). Refuses a bad key, bytes over MAX_UPLOAD_BYTES
   * (StorageTooLargeError) and a key that already exists (StorageConflictError).
   */
  createUploadGrant(req: UploadGrantRequest): Promise<UploadGrant>;
  /** A signed GET URL for a private object (`uploads`), valid `expiresInSeconds`. */
  createSignedReadUrl(
    bucket: StorageBucket,
    key: string,
    expiresInSeconds: number,
  ): Promise<string>;
  /**
   * Server-side / CLI write: streams to a temp file and renames (atomic), so a reader never sees
   * half an object. No size cap here (PMTiles are big); never call it with a request body
   * (those go through grants). Identical bytes at an existing key: no-op; different bytes:
   * StorageConflictError.
   */
  put(
    bucket: StorageBucket,
    key: string,
    body: Readable | Uint8Array,
    opts?: PutOptions,
  ): Promise<StorageObjectInfo>;
  /** Delete one object (CLI cleanup only: an old version after gis.map_layers points at the new one). */
  delete(bucket: StorageBucket, key: string): Promise<boolean>;
}
