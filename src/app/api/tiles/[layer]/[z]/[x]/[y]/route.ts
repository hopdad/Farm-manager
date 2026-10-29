/**
 * GET /api/tiles/<layer>/<z>/<x>/<y>[?v=<version>]: app vector tiles via ST_AsMVT (plan §1).
 * M0 layer: `fields` (app.mvt_fields, private). Logic and cache policy: ../../../../handler.ts.
 * proxy.ts must never run on /api/tiles, and the route never answers 3xx (contracts §5).
 */
import { getPool } from '@/db/client';
import { handleTileRequest, type TileParams } from '../../../../handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: { params: Promise<TileParams> },
): Promise<Response> {
  return handleTileRequest(request, await ctx.params, getPool());
}
