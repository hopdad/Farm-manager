/**
 * GET /api/pins[?fieldId=<uuid>][&resolved=1] (slice 1f, docs/contracts-1f.md §5.2; owner:
 * deere-data): the pins the map and the popups show (Deere flags, read-only), open ones unless
 * `resolved=1` (then resolved ones too), optionally of one field. Viewer and up:
 * requireRole(ROLE_FOR.viewPrivate) runs FIRST, on the server. `no-store` (private data),
 * through limitedJson. Framework-free (Web Request/Response, a pg Pool) so DB tests drive it
 * with runWithSession.
 */
import type pg from 'pg';
import { authErrorResponse, requireRole } from '@/platform/auth/server';
import { ROLE_FOR } from '@/platform/auth/types';
import { limitedJson } from '@/platform/http/limits';
import { listPins } from '../../../db/queries/pins';
import type { PinsResponse } from '../../../domain/pins';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { 'cache-control': 'no-store' };

function json(body: unknown, status = 200): Response {
  return limitedJson(body, { status, headers: NO_STORE }, { route: 'api/pins' });
}

export async function handleListPins(
  request: Request,
  pool: pg.Pool,
  now: () => Date = () => new Date(),
): Promise<Response> {
  try {
    await requireRole(ROLE_FOR.viewPrivate);
  } catch (e) {
    const auth = authErrorResponse(e);
    if (auth) return auth;
    throw e;
  }
  const q = new URL(request.url).searchParams;
  const fieldId = q.get('fieldId');
  if (fieldId !== null && !UUID_RE.test(fieldId)) return json({ error: 'bad fieldId' }, 400);
  const resolved = q.get('resolved');
  if (resolved !== null && resolved !== '1' && resolved !== '0') {
    return json({ error: 'resolved must be 1 or 0' }, 400);
  }
  const pins = await listPins(pool, { fieldId, resolved: resolved === '1' });
  const body: PinsResponse = { builtAt: now().toISOString(), pins };
  return json(body);
}
