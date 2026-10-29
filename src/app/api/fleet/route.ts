/**
 * GET /api/fleet: the fleet snapshot (contracts §7), `FleetTick` of every non-retired machine
 * with a known position, `stale` recomputed per request. The board and /m load it on start and
 * in every realtime `onResync` (reconnect, seq gap, `invalidate`). Built by the same query as the
 * fleet.* jobs' batched `fleet.tick` (src/db/queries/fleet.ts).
 */
import { getConfig } from '@/config';
import { getPool } from '@/db/client';
import { fleetSnapshot, staleThresholdsOf } from '@/db/queries/fleet';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const headers = { 'cache-control': 'no-store' };
  try {
    const cfg = getConfig();
    const tick = await fleetSnapshot(getPool(), new Date(), staleThresholdsOf(cfg));
    return Response.json(tick, { headers });
  } catch (e) {
    console.error('[api/fleet]', (e as Error).message);
    return Response.json({ error: 'fleet snapshot unavailable' }, { status: 503, headers });
  }
}
