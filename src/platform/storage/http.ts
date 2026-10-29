/**
 * Serve a storage object over HTTP (contracts §10): GET/HEAD with byte ranges (PMTiles),
 * strong ETags, conditional requests and the cache policy below. Used by
 * src/app/api/storage/[bucket]/[...key]/route.ts; framework-free (Web Request/Response) so it is
 * unit-tested against a temp directory.
 *
 *  - only buckets in PUBLIC_READ_BUCKETS (M0: `tiles`) → else 404
 *  - bad key → 400; missing object → 404
 *  - `Accept-Ranges: bytes`; `Range: bytes=a-b | a- | -n` → 206 + Content-Range; unsatisfiable → 416
 *  - ETag `"<sha8>"` for content-addressed keys (`name.<sha8>.ext`), `"<size>-<mtime>"` otherwise;
 *    `If-None-Match` → 304; `If-Range` with another ETag → whole object (200)
 *  - Cache-Control: `public, max-age=31536000, immutable` for content-addressed keys and
 *    `assets/**`, `no-cache` for everything else (notably `basemap.json`)
 *  - the body is streamed from disk (never buffered)
 */
import { Readable } from 'node:stream';
import { contentTypeFor } from './content-type';
import {
  contentHashOf,
  isStorageBucket,
  PUBLIC_READ_BUCKETS,
  parseStorageKey,
  type StorageBucket,
  StorageKeyError,
} from './keys';
import { contentRange, parseRange, unsatisfiedRange } from './range';
import type { StorageObjectInfo, StorageReader } from './types';

export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
export const REVALIDATE_CACHE = 'no-cache';

/** Cache-Control for a key in the `tiles` bucket. */
export function cacheControlFor(key: string): string {
  if (contentHashOf(key) || key.startsWith('assets/')) return IMMUTABLE_CACHE;
  return REVALIDATE_CACHE;
}

/** Strong ETag: the content hash for content-addressed keys, else size + mtime. */
export function etagFor(info: Pick<StorageObjectInfo, 'key' | 'size' | 'mtime'>): string {
  const sha8 = contentHashOf(info.key);
  if (sha8) return `"${sha8}"`;
  return `"${info.size.toString(16)}-${Math.floor(info.mtime.getTime()).toString(16)}"`;
}

/** Does an If-None-Match header match `etag` (weak comparison, RFC 9110 §13.1.2)? */
export function ifNoneMatchHits(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => t.trim() === '*' || bare(t) === bare(etag));
}

/** Should a Range be honoured given If-Range (strong comparison; dates must equal Last-Modified)? */
export function ifRangeAllows(header: string | null, etag: string, lastModified: string): boolean {
  if (!header) return true;
  const v = header.trim();
  if (v.startsWith('"') || v.startsWith('W/')) return v === etag;
  return v === lastModified;
}

function errorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function serveStorageObject(
  request: Request,
  storage: StorageReader,
  bucketParam: string,
  keyParam: string | readonly string[],
): Promise<Response> {
  if (!isStorageBucket(bucketParam) || !PUBLIC_READ_BUCKETS.includes(bucketParam)) {
    return errorResponse(404, 'not found');
  }
  const bucket: StorageBucket = bucketParam;
  let key: string;
  try {
    key = parseStorageKey(keyParam);
  } catch (e) {
    if (e instanceof StorageKeyError) return errorResponse(400, `bad key: ${e.message}`);
    throw e;
  }
  const info = await storage.stat(bucket, key);
  if (!info) return errorResponse(404, 'not found');

  const etag = etagFor(info);
  const lastModified = info.mtime.toUTCString();
  const headers = new Headers({
    'accept-ranges': 'bytes',
    'cache-control': cacheControlFor(key),
    'content-type': contentTypeFor(key),
    etag,
    'last-modified': lastModified,
    'x-content-type-options': 'nosniff',
  });

  if (ifNoneMatchHits(request.headers.get('if-none-match'), etag)) {
    headers.delete('content-type');
    return new Response(null, { status: 304, headers });
  }

  const isHead = request.method === 'HEAD';
  const rangeHeader = ifRangeAllows(request.headers.get('if-range'), etag, lastModified)
    ? request.headers.get('range')
    : null;
  const range = parseRange(rangeHeader, info.size);

  if (range.kind === 'unsatisfiable') {
    headers.set('content-range', unsatisfiedRange(info.size));
    headers.set('content-type', 'text/plain; charset=utf-8');
    return new Response(isHead ? null : 'range not satisfiable', { status: 416, headers });
  }

  if (range.kind === 'range') {
    headers.set('content-range', contentRange(range.start, range.end, info.size));
    headers.set('content-length', String(range.end - range.start + 1));
    if (isHead) return new Response(null, { status: 206, headers });
    const stream = await storage.openRead(bucket, key, { start: range.start, end: range.end });
    return new Response(toWebStream(stream), { status: 206, headers });
  }

  headers.set('content-length', String(info.size));
  if (isHead || info.size === 0) return new Response(isHead ? null : '', { status: 200, headers });
  const stream = await storage.openRead(bucket, key);
  return new Response(toWebStream(stream), { status: 200, headers });
}

function toWebStream(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}
