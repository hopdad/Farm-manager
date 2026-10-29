/**
 * GET /api/weather/spray: field id -> spray verdict for the current hour (SprayMapResponse), what
 * SprayFieldState paints on the map. Needs a session (viewer); `no-store`. Handler: ../handler.ts.
 */
import { getPool } from '@/db/client';
import { handleSprayMap } from '../handler';

export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  return handleSprayMap(getPool());
}
