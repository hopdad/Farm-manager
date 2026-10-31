/**
 * POST /admin/vehicles/kind (slice 1f.2, terminal-pickups): set a vehicle's kind by hand without
 * the page, JSON `{ machineId, kind }` (semi, pickup, service_truck) or `{ machineId, release:
 * true }`. Framework-free so the DB test calls it under a session:
 *
 *   requireRole(ROLE_FOR.admin) FIRST (401 signed out, 403 for a viewer, driver or operator),
 *   then 403 for a cross-site request, 415 unless application/json, 413 over 4 KiB, 400 for a bad
 *   body, 404 for an unknown machine, else 200 `{ ok: true, machineId, kind, kindSetBy }` and ONE
 *   `fleet`/`invalidate`. Every answer is JSON and `no-store`.
 */
import type { Executor } from '@/db/exec';
import { authErrorResponse, requireRole } from '@/platform/auth/server';
import { ROLE_FOR } from '@/platform/auth/types';
import { limitedJson, readLimitedText } from '@/platform/http/limits';
import { isSameOriginRequest } from '@/platform/http/origin';
import { setVehicleKind, setVehicleKindRequestSchema } from '../_lib/set-kind';

export const MAX_VEHICLE_KIND_BODY_BYTES = 4 * 1024;

function json(status: number, body: unknown): Response {
  return limitedJson(
    body,
    { status, headers: { 'cache-control': 'no-store' } },
    { route: 'admin/vehicles/kind' },
  );
}

export async function handleSetVehicleKind(request: Request, ex: Executor): Promise<Response> {
  try {
    await requireRole(ROLE_FOR.admin);
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    throw e;
  }
  if (!isSameOriginRequest(request)) return json(403, { error: 'cross-site request refused' });
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return json(415, { error: 'send application/json' });
  }
  const text = await readLimitedText(request, MAX_VEHICLE_KIND_BODY_BYTES);
  if (text === null) return json(413, { error: 'body too large' });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return json(400, { error: 'body is not JSON' });
  }
  const parsed = setVehicleKindRequestSchema.safeParse(value);
  if (!parsed.success) {
    return json(400, {
      error:
        "expected { machineId, kind: 'semi' | 'pickup' | 'service_truck' } or { machineId, release: true }",
    });
  }
  const row = await setVehicleKind(ex, parsed.data);
  if (!row) return json(404, { error: 'no such machine' });
  return json(200, {
    ok: true,
    machineId: parsed.data.machineId,
    kind: row.kind,
    kindSetBy: row.kindSetBy,
  });
}
