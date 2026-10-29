/**
 * GET/HEAD /api/storage/<bucket>/<key…>: the local storage adapter's read side (contracts §10).
 * M0 serves bucket `tiles` only (the offline basemap and its fonts/sprites): byte ranges for
 * PMTiles, strong ETags, 304s, content types and cache headers live in
 * src/platform/storage/http.ts. Streams from disk; never buffers. Never answers 3xx.
 */
import { getStorage } from '@/platform/storage';
import { serveStorageObject } from '@/platform/storage/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ bucket: string; key: string[] }>;
}

async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const { bucket, key } = await ctx.params;
  try {
    return await serveStorageObject(request, getStorage(), bucket, key);
  } catch (e) {
    console.error('[storage] read failed:', (e as Error).message);
    return new Response('storage read failed', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}

export function GET(request: Request, ctx: Ctx): Promise<Response> {
  return handle(request, ctx);
}

export function HEAD(request: Request, ctx: Ctx): Promise<Response> {
  return handle(request, ctx);
}
