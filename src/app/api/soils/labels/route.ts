/**
 * GET /api/soils/labels?bbox=&z=[&v=]: one label point per soil polygon in view (soil map
 * Phase A). Viewer-level, like the tiles route's private layers. Logic: ../handler.ts; contract:
 * src/ui/map/layers/soils-labels.ts.
 */
import { getPool } from '@/db/client';
import { handleSoilLabels } from '../handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleSoilLabels(request, getPool());
}
