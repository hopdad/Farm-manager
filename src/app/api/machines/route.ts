/**
 * GET /api/machines: the fleet panel's list (every machine that isn't retired, with its latest
 * fix, down state and the geofence it is in). Viewer and up. Logic: ./handler.ts.
 */
import { getPool } from '@/db/client';
import { handleListMachines } from './handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handleListMachines(getPool());
}
