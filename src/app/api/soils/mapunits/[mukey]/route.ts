/**
 * GET /api/soils/mapunits/<mukey>: one soil map unit with its components, for the map unit sheet
 * (soil map Phase A). Viewer-level. Logic: ../../handler.ts; shape: src/ui/soils/protocol.ts.
 */
import { getPool } from '@/db/client';
import { handleMapUnit } from '../../handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ mukey: string }> },
): Promise<Response> {
  const { mukey } = await ctx.params;
  return handleMapUnit(mukey, getPool());
}
