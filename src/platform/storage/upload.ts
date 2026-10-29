/**
 * The /api/storage route's signed paths (docs/contracts-m1.md §9), framework-free (Web Request /
 * Response) so the adapter contract tests drive them without Next:
 *
 *  - `handleStoragePut`: step 2 of an upload. The URL must carry a valid, unexpired PUT signature
 *    for exactly this bucket and key (./signing.ts), and the request the signed Content-Type.
 *    The body is streamed into the writer and never read past the grant's byte limit (at most
 *    MAX_UPLOAD_BYTES, the 4 MB request limit): Content-Length over it → 413 without reading;
 *    a chunked body is cut off at the limit → 413 and nothing is stored. Existing key: identical
 *    bytes → 200 (a retried upload), different bytes → 409 (no overwrites). Bad or expired
 *    signature → 403. Content-addressed key with other bytes → 400.
 *  - `handleStorageRead`: GET/HEAD. Bucket `tiles` (and anything unsigned) goes to
 *    serveStorageObject exactly as in M0 (so an unsigned `uploads` request is still a 404). An
 *    `uploads` request with a signature: bad or expired → 403; valid → served with
 *    `{ access: 'signed' }` (Range, ETag, `Cache-Control: private, no-store`).
 */
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { limitedJson } from '../http/limits';
import { serveStorageObject } from './http';
import { isStorageBucket, type StorageBucket, StorageKeyError, tryParseStorageKey } from './keys';
import { normalizeContentType, SIGNED_PARAMS, verifySignedGet, verifySignedPut } from './signing';
import {
  MAX_UPLOAD_BYTES,
  StorageConflictError,
  type StorageReader,
  StorageTooLargeError,
} from './types';
import { type LocalStorageWriter, StorageHashMismatchError } from './writer';

/** Buckets whose objects are served only through a signed GET. */
const SIGNED_READ_BUCKETS: readonly StorageBucket[] = ['uploads'];

function jsonError(status: number, error: string): Response {
  return limitedJson({ error }, { status, headers: { 'cache-control': 'no-store' } });
}

function keyOf(keyParam: string | readonly string[]): string | null {
  return tryParseStorageKey(keyParam);
}

export interface SignedRouteOptions {
  /** SESSION_SECRET (the signing key's source). */
  secret: string;
  /** Clock for expiry checks (tests). */
  now?: Date;
}

export async function handleStorageRead(
  request: Request,
  storage: StorageReader,
  bucketParam: string,
  keyParam: string | readonly string[],
  opts: SignedRouteOptions,
): Promise<Response> {
  const q = new URL(request.url).searchParams;
  if (
    !isStorageBucket(bucketParam) ||
    !SIGNED_READ_BUCKETS.includes(bucketParam) ||
    !q.has(SIGNED_PARAMS.signature)
  ) {
    return serveStorageObject(request, storage, bucketParam, keyParam);
  }
  const key = keyOf(keyParam);
  // A bad key answers exactly as an unsigned request would (uploads is not public: 404).
  if (key === null) return serveStorageObject(request, storage, bucketParam, keyParam);
  const v = verifySignedGet(opts.secret, bucketParam, key, q, opts.now ?? new Date());
  if (!v.ok) return jsonError(403, `signed URL refused: ${v.reason}`);
  return serveStorageObject(request, storage, bucketParam, key, { access: 'signed' });
}

export async function handleStoragePut(
  request: Request,
  writer: Pick<LocalStorageWriter, 'putObject'>,
  bucketParam: string,
  keyParam: string | readonly string[],
  opts: SignedRouteOptions,
): Promise<Response> {
  if (!isStorageBucket(bucketParam)) return jsonError(404, 'not found');
  const key = keyOf(keyParam);
  if (key === null) return jsonError(400, 'bad key');

  const v = verifySignedPut(
    opts.secret,
    bucketParam,
    key,
    new URL(request.url).searchParams,
    opts.now ?? new Date(),
  );
  if (!v.ok) return jsonError(403, `upload refused: ${v.reason}`);
  const { claims } = v;

  const sent = normalizeContentType(request.headers.get('content-type') ?? '');
  if (sent !== normalizeContentType(claims.contentType)) {
    return jsonError(403, `upload refused: content-type must be ${claims.contentType}`);
  }
  const limit = Math.min(claims.maxBytes, MAX_UPLOAD_BYTES);
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await request.body?.cancel().catch(() => undefined);
    return jsonError(413, `upload over ${limit} bytes`);
  }

  const body = request.body
    ? Readable.fromWeb(request.body as WebReadableStream<Uint8Array>)
    : new Uint8Array();
  try {
    const r = await writer.putObject(bucketParam, key, body, {
      contentType: claims.contentType,
      maxBytes: limit,
    });
    return limitedJson(
      { bucket: bucketParam, key, size: r.info.size, created: r.created },
      { status: r.created ? 201 : 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    if (e instanceof StorageTooLargeError) return jsonError(413, e.message);
    if (e instanceof StorageConflictError) return jsonError(409, e.message);
    if (e instanceof StorageHashMismatchError) return jsonError(400, e.message);
    if (e instanceof StorageKeyError) return jsonError(400, e.message);
    throw e;
  }
}
