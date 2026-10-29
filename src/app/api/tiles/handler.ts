/**
 * The tiles route's logic (framework-free; the DB test calls it with a test database).
 *
 *  - unknown layer → 404; malformed or out-of-range z/x/y → 400 (`y` may end in .mvt or .pbf)
 *  - 200 `application/vnd.mapbox-vector-tile`, possibly empty (an empty tile is a valid MVT)
 *  - Cache-Control: with `?v=<version>` the URL is immutable for its policy
 *    (`private, max-age=31536000, immutable` for private layers such as fields;
 *    `public, max-age=31536000, s-maxage=31536000, immutable` for public ones); without `v`,
 *    `private, no-cache` / `public, no-cache`. A strong ETag (hash of the bytes) answers
 *    `If-None-Match` with 304.
 *  - database errors → 503 `no-store` (MapLibre retries the tile on the next render)
 *  - private layers first run `opts.checkAccess` (the route passes requireRole('viewer')): an
 *    AuthError becomes 401/403 `no-store` (contracts-m1 §4)
 *  - never 3xx (contracts §5)
 */
import { createHash } from 'node:crypto';
import type { Queryable } from '@/db/client';
import { isAuthError } from '@/platform/auth/types';
import { limitedBytes } from '@/platform/http/limits';
import { isValidTile } from '@/ui/map/tile-math';
import { isTileLayerId, TILE_LAYERS, type TileCachePolicy, type TileLayerDef } from './layers';

export const MVT_CONTENT_TYPE = 'application/vnd.mapbox-vector-tile';
const VERSION_RE = /^[0-9A-Za-z_.-]{1,64}$/;

export interface TileParams {
  layer: string;
  z: string;
  x: string;
  y: string;
}

/** Parse "12" / "1234.mvt" / "1234.pbf" into an integer, or null. */
export function parseTileInt(s: string, allowExt = false): number | null {
  const m = (allowExt ? /^(\d{1,8})(?:\.(?:mvt|pbf))?$/ : /^(\d{1,8})$/).exec(s);
  return m ? Number(m[1]) : null;
}

export function tileCacheControl(policy: TileCachePolicy, versioned: boolean): string {
  if (!versioned) return `${policy}, no-cache`;
  return policy === 'private'
    ? 'private, max-age=31536000, immutable'
    : 'public, max-age=31536000, s-maxage=31536000, immutable';
}

function text(status: number, body: string): Response {
  return limitedBytes(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export interface TileRequestOptions {
  /**
   * Called before serving a PRIVATE layer; throw an AuthError to refuse. The route passes
   * `() => requireRole('viewer')`; omitted (tests, tools) means no check.
   */
  checkAccess?: () => Promise<unknown>;
}

export async function handleTileRequest(
  request: Request,
  params: TileParams,
  ex: Queryable,
  opts: TileRequestOptions = {},
): Promise<Response> {
  if (!isTileLayerId(params.layer)) return text(404, 'unknown layer');
  const def: TileLayerDef = TILE_LAYERS[params.layer];
  if (def.cachePolicy === 'private' && opts.checkAccess) {
    try {
      await opts.checkAccess();
    } catch (e) {
      if (isAuthError(e)) return text(e.status, e.message);
      throw e;
    }
  }
  const z = parseTileInt(params.z);
  const x = parseTileInt(params.x);
  const y = parseTileInt(params.y, true);
  if (z === null || x === null || y === null || !isValidTile(z, x, y)) {
    return text(400, 'bad tile coordinates');
  }
  const v = new URL(request.url).searchParams.get('v');
  if (v !== null && !VERSION_RE.test(v)) return text(400, 'bad version');

  let mvt: Buffer;
  try {
    const r = await ex.query<{ mvt: Buffer | null }>(def.sql, [z, x, y]);
    mvt = r.rows[0]?.mvt ?? Buffer.alloc(0);
  } catch (e) {
    console.error(`[tiles] ${params.layer}/${z}/${x}/${y} failed:`, (e as Error).message);
    return text(503, 'tile query failed');
  }

  const etag = `"${createHash('sha1').update(mvt).digest('hex').slice(0, 20)}"`;
  const headers = new Headers({
    'content-type': MVT_CONTENT_TYPE,
    'cache-control': tileCacheControl(def.cachePolicy, v !== null),
    etag,
    'x-content-type-options': 'nosniff',
  });
  const inm = request.headers.get('if-none-match');
  if (inm?.split(',').some((t) => t.trim().replace(/^W\//, '') === etag || t.trim() === '*')) {
    headers.delete('content-type');
    return new Response(null, { status: 304, headers });
  }
  headers.set('content-length', String(mvt.length));
  return limitedBytes(new Uint8Array(mvt), { status: 200, headers }, { route: 'api/tiles' });
}
