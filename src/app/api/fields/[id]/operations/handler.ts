/**
 * GET /api/fields/<id>/operations[?cropYear=YYYY] (slice 1f, deere-ops; docs/contracts-1f.md
 * §5.1) → `FieldOperationsResponse`: the field's operations of one crop year (default: the
 * current one, America/Detroit), oldest first, for the History tab. Framework-free (the DB test
 * calls it under runWithSession):
 *
 *  - requireRole(ROLE_FOR.viewPrivate) FIRST (401/403 JSON otherwise);
 *  - 400 for a crop year that isn't a year (1950-2100), 404 for an unknown or malformed field,
 *    503 when the database is unavailable;
 *  - `Cache-Control: private, no-store`, through limitedJson; the realtime adapter and the app's
 *    environment ride in two headers (src/ui/fields/operations.ts) so the tab subscribes to
 *    `fields`/`updated` without reading config.
 */
import { getConfig } from '@/config';
import type { Executor } from '@/db/exec';
import { fieldOperations } from '@/db/queries/operations';
import { currentCropYear } from '@/domain/crops';
import type { FieldOperationsResponse } from '@/domain/operations';
import { authErrorResponse, requireRole } from '@/platform/auth/server';
import { ROLE_FOR } from '@/platform/auth/types';
import { limitedJson } from '@/platform/http/limits';
import { OPERATIONS_APP_ENV_HEADER, OPERATIONS_REALTIME_HEADER } from '@/ui/fields/operations';

const ROUTE = { route: 'api/fields/operations' };

function json(status: number, body: unknown): Response {
  return limitedJson(body, { status, headers: { 'cache-control': 'no-store' } }, ROUTE);
}

/** `cropYear` of the query: a year 1950-2100, absent = null, anything else = 'invalid'. */
export function parseCropYear(url: URL): number | null | 'invalid' {
  const raw = url.searchParams.get('cropYear');
  if (raw === null || raw === '') return null;
  if (!/^\d{4}$/.test(raw)) return 'invalid';
  const y = Number(raw);
  return y >= 1950 && y <= 2100 ? y : 'invalid';
}

export async function handleFieldOperations(
  request: Request,
  fieldId: string,
  ex: Executor,
  now: Date = new Date(),
): Promise<Response> {
  try {
    await requireRole(ROLE_FOR.viewPrivate);
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    throw e;
  }
  const asked = parseCropYear(new URL(request.url));
  if (asked === 'invalid') return json(400, { error: 'cropYear must be a year (1950-2100)' });
  const cropYear = asked ?? currentCropYear(now);
  try {
    const operations = await fieldOperations(ex, fieldId, cropYear);
    if (!operations) return json(404, { error: 'field not found' });
    const body: FieldOperationsResponse = { fieldId, cropYear, operations };
    const cfg = getConfig();
    return limitedJson(
      body,
      {
        headers: {
          'cache-control': 'private, no-store',
          [OPERATIONS_REALTIME_HEADER]: cfg.NEXT_PUBLIC_REALTIME,
          [OPERATIONS_APP_ENV_HEADER]: cfg.APP_ENV,
        },
      },
      ROUTE,
    );
  } catch (e) {
    console.error('[api/fields/operations]', (e as Error).message);
    return json(503, { error: 'field operations unavailable' });
  }
}
