/**
 * /api/storage/<bucket>/<key…>: the local storage adapter over HTTP (contracts §10,
 * docs/contracts-m1.md §9). Never answers 3xx; streams, never buffers.
 *
 *  - GET/HEAD: bucket `tiles` (the offline basemap, fonts, sprites, raster PMTiles) exactly as in
 *    M0: byte ranges, strong ETags, 304s, content types and cache headers live in
 *    src/platform/storage/http.ts. Bucket `uploads` only through a signed URL
 *    (`createSignedReadUrl`): unsigned → 404 as in M0, bad or expired → 403, valid → private,
 *    no-store (src/platform/storage/upload.ts `handleStorageRead`).
 *  - PUT: step 2 of a two-step upload, to the URL a route handler got from `createUploadGrant`
 *    after its requireRole check: HMAC-signed (expiry, byte limit and content type inside the
 *    signature), at most 4 MB, no overwrites (`handleStoragePut`).
 */
import { getConfig } from '@/config';
import { getStorage } from '@/platform/storage';
import { handleStoragePut, handleStorageRead } from '@/platform/storage/upload';
import { getLocalStorageWriter } from '@/platform/storage/writer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ bucket: string; key: string[] }>;
}

function failed(what: 'read' | 'write', e: unknown): Response {
  console.error(`[storage] ${what} failed:`, (e as Error).message);
  return new Response(`storage ${what} failed`, {
    status: 500,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function read(request: Request, ctx: Ctx): Promise<Response> {
  const { bucket, key } = await ctx.params;
  try {
    return await handleStorageRead(request, getStorage(), bucket, key, {
      secret: getConfig().SESSION_SECRET,
    });
  } catch (e) {
    return failed('read', e);
  }
}

export function GET(request: Request, ctx: Ctx): Promise<Response> {
  return read(request, ctx);
}

export function HEAD(request: Request, ctx: Ctx): Promise<Response> {
  return read(request, ctx);
}

export async function PUT(request: Request, ctx: Ctx): Promise<Response> {
  const { bucket, key } = await ctx.params;
  try {
    return await handleStoragePut(request, getLocalStorageWriter(), bucket, key, {
      secret: getConfig().SESSION_SECRET,
    });
  } catch (e) {
    return failed('write', e);
  }
}
