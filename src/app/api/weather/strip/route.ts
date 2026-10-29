/**
 * GET /api/weather/strip: the weather strip (WeatherStripPayload, src/ui/weather/contract.ts)
 * for /board and /m. Needs a session (viewer); `no-store`. Handler: ../handler.ts.
 */
import { getPool } from '@/db/client';
import { handleStrip } from '../handler';

export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  return handleStrip(getPool());
}
