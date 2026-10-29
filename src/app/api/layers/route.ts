/**
 * GET /api/layers: the map layer registry with URLs resolved (contract docs/contracts-m1.md §7.4;
 * owner: soils). The layer rail loads it on start and again on realtime `layers`/`updated` (and
 * on resync). Public rows for everyone; private rows (fields, parcels with owners, tile lines)
 * only for a session that may view private data. `Cache-Control: no-store`; through the 4 MB
 * guard. Logic: ./rows.ts.
 */
import { getPool } from '@/db/client';
import { getSession } from '@/platform/auth/server';
import { limitedJson } from '@/platform/http/limits';
import { getStorage } from '@/platform/storage';
import { listMapLayers, mayViewPrivate } from './rows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const headers = { 'cache-control': 'no-store' };
  const session = await getSession();
  try {
    const body = await listMapLayers(getPool(), getStorage(), {
      includePrivate: mayViewPrivate(session),
    });
    return limitedJson(body, { headers }, { route: 'api/layers' });
  } catch (e) {
    console.error('[api/layers]', (e as Error).message);
    return limitedJson({ error: 'map layers unavailable' }, { status: 503, headers });
  }
}
