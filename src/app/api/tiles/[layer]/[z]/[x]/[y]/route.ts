/**
 * GET /api/tiles/<layer>/<z>/<x>/<y>[?v=<version>]: app vector tiles via ST_AsMVT (plan §1).
 * Layers: ../../../../layers.ts (fields, parcels, tile_lines are private and need a session;
 * soils is public). Logic and cache policy: ../../../../handler.ts.
 * proxy.ts must never run on /api/tiles, and the route never answers 3xx (contracts §5).
 */
import { getPool } from '@/db/client';
import { requireRole } from '@/platform/auth/server';
import { handleTileRequest, type TileParams } from '../../../../handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  ctx: { params: Promise<TileParams> },
): Promise<Response> {
  return handleTileRequest(request, await ctx.params, getPool(), {
    checkAccess: () => requireRole('viewer'),
  });
}
