/**
 * The soil map's routes (soil map Phase A; framework-free, the DB tests call them under
 * runWithSession). Owner: soils. Both read public SSURGO data, but they run a query per request
 * (unlike the versioned, cacheable soils tiles), so they are viewer-level: requireRole('viewer')
 * first, 401/403 JSON otherwise (contracts-m1 §4), like the private tiles.
 *
 *  GET /api/soils/labels?bbox=<w>,<s>,<e>,<n>&z=<13-22>[&v=<soils version>]
 *    → 200 SoilLabelsResponse (a GeoJSON FeatureCollection: one label point per soil polygon
 *      meeting the bbox, largest first, capped; src/ui/map/layers/soils-labels.ts). 400 for a
 *      bad query (z below 13, a bbox too wide for z). `private, max-age=86400` when the URL names
 *      the soils version (a reload of the soils gives new URLs), else `private, no-cache`.
 *  GET /api/soils/mapunits/<mukey>
 *    → 200 MapUnitDetail (src/ui/soils/protocol.ts), 404 unknown, 400 malformed; `private,
 *      no-cache`.
 *  Database errors → 503 `no-store`. Every answer goes through limitedJson (the 4 MB guard).
 */
import type { Queryable } from '@/db/client';
import { mapUnitDetail } from '@/db/queries/soils';
import { soilLabels } from '@/db/queries/soils-labels';
import { authErrorResponse, requireRole } from '@/platform/auth/server';
import { limitedJson } from '@/platform/http/limits';
import {
  minLabelAreaDeg2,
  parseSoilLabelsQuery,
  SOIL_LABEL_LIMIT,
  type SoilLabelsResponse,
} from '@/ui/map/layers/soils-labels';
import { MUKEY_RE } from '@/ui/soils/protocol';

const NO_STORE = { 'cache-control': 'no-store' } as const;

function json(route: string, status: number, body: unknown, cache: string): Response {
  return limitedJson(body, { status, headers: { 'cache-control': cache } }, { route });
}

/** requireRole('viewer'), as a response when refused. */
async function refused(): Promise<Response | null> {
  try {
    await requireRole('viewer');
    return null;
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    throw e;
  }
}

export async function handleSoilLabels(
  request: Request,
  ex: Queryable,
  opts: { limit?: number } = {},
): Promise<Response> {
  const route = 'api/soils/labels';
  const no = await refused();
  if (no) return no;
  const parsed = parseSoilLabelsQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return json(route, 400, { error: parsed.error }, NO_STORE['cache-control']);
  const { bbox, z, v } = parsed.query;
  const limit = opts.limit ?? SOIL_LABEL_LIMIT;
  try {
    const r = await soilLabels(ex, {
      bbox,
      minAreaDeg2: minLabelAreaDeg2(z, (bbox.south + bbox.north) / 2),
      limit,
    });
    const body: SoilLabelsResponse = {
      type: 'FeatureCollection',
      features: r.features,
      z,
      limit,
      truncated: r.truncated,
    };
    return json(route, 200, body, v ? 'private, max-age=86400' : 'private, no-cache');
  } catch (e) {
    console.error(`[${route}]`, (e as Error).message);
    return json(route, 503, { error: 'soil labels unavailable' }, NO_STORE['cache-control']);
  }
}

export async function handleMapUnit(mukey: string, ex: Queryable): Promise<Response> {
  const route = 'api/soils/mapunits';
  const no = await refused();
  if (no) return no;
  if (!MUKEY_RE.test(mukey)) return json(route, 400, { error: 'bad map unit key' }, 'no-store');
  try {
    const detail = await mapUnitDetail(ex, mukey);
    if (!detail) return json(route, 404, { error: 'map unit not found' }, 'no-store');
    return json(route, 200, detail, 'private, no-cache');
  } catch (e) {
    console.error(`[${route}]`, (e as Error).message);
    return json(route, 503, { error: 'map unit unavailable' }, 'no-store');
  }
}
