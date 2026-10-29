/**
 * The fleet panel's routes (framework-free, so the DB tests call them under runWithSession):
 *
 *  GET /api/machines -> 200 FleetPanelData (src/ui/fleet/contract.ts): requireRole('viewer')
 *    first (401/403 JSON otherwise), `Cache-Control: no-store`; 503 when the database is down.
 *    `canMarkDown` comes from the session's role (the server checks again on every POST).
 *
 *  POST /api/machines/<id>/status, JSON `{ status: 'down', reason }` or `{ status: 'active' }`
 *    -> requireRole(ROLE_FOR.markMachineDown) FIRST, then: 403 for a cross-site request (an
 *    Origin that isn't this host), 415 unless application/json, 413 over 8 KiB, 400 for a bad
 *    body, 404 for an unknown machine, 409 for a retired one, else 200 MachineStatusResult with
 *    `fleet`/`machine` + `fleet`/`invalidate` published in the same transaction. Every answer
 *    is JSON and `no-store` (limitedJson).
 */
import { type Config, getConfig } from '@/config';
import type { Db } from '@/db/client';
import type { Executor } from '@/db/exec';
import { fleetPanelMachines, setMachineStatus } from '@/db/queries/fleet';
import { isUuid } from '@/domain/ids';
import { authErrorResponse, requireRole } from '@/platform/auth/server';
import { ROLE_FOR, roleAtLeast } from '@/platform/auth/types';
import { limitedJson, readLimitedText } from '@/platform/http/limits';
import {
  type FleetPanelData,
  type MachineStatusResult,
  setMachineStatusBodySchema,
} from '@/ui/fleet/contract';

/** A status body is a few hundred bytes; anything near this is not one. */
export const MAX_STATUS_BODY_BYTES = 8 * 1024;

const NO_STORE = { 'cache-control': 'no-store' } as const;

type PanelConfig = Pick<
  Config,
  | 'APP_ENV'
  | 'NEXT_PUBLIC_REALTIME'
  | 'FLEET_STALE_SECONDS'
  | 'FLEET_STALE_SECONDS_DEERE'
  | 'CONNECTOR_DEERE'
  | 'CONNECTOR_ELD'
  | 'ELD_VENDOR'
>;

function json(status: number, body: unknown, route = 'api/machines'): Response {
  return limitedJson(body, { status, headers: NO_STORE }, { route });
}

/**
 * Is the request from a page of this app (or not from a browser page at all)? Browsers send
 * `Origin` on every POST; it must name the host the request came to (the LAN address,
 * localhost, or the production domain behind Vercel's x-forwarded-host).
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  try {
    return host !== null && new URL(origin).host === host.split(',')[0]?.trim();
  } catch {
    return false;
  }
}

export async function handleListMachines(
  ex: Executor,
  cfg: () => PanelConfig = getConfig,
  now: Date = new Date(),
): Promise<Response> {
  let role: Parameters<typeof roleAtLeast>[0];
  try {
    role = (await requireRole('viewer')).role;
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    throw e;
  }
  try {
    const c = cfg();
    const body: FleetPanelData = {
      builtAt: now.toISOString(),
      machines: await fleetPanelMachines(ex),
      canMarkDown: roleAtLeast(role, ROLE_FOR.markMachineDown),
      modes: { deere: c.CONNECTOR_DEERE, eld: c.CONNECTOR_ELD, eldVendor: c.ELD_VENDOR },
      config: {
        appEnv: c.APP_ENV,
        realtime: c.NEXT_PUBLIC_REALTIME,
        staleAfterSeconds: c.FLEET_STALE_SECONDS,
        deereStaleAfterSeconds: c.FLEET_STALE_SECONDS_DEERE,
      },
    };
    return json(200, body);
  } catch (e) {
    console.error('[api/machines]', (e as Error).message);
    return json(503, { error: 'fleet unavailable' });
  }
}

export async function handleSetMachineStatus(
  request: Request,
  machineId: string,
  db: Db,
): Promise<Response> {
  const route = 'api/machines/status';
  let session: Awaited<ReturnType<typeof requireRole>>;
  try {
    session = await requireRole(ROLE_FOR.markMachineDown);
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    throw e;
  }
  if (!isSameOriginRequest(request))
    return json(403, { error: 'cross-site request refused' }, route);
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) {
    return json(415, { error: 'send the status as application/json' }, route);
  }
  const text = await readLimitedText(request, MAX_STATUS_BODY_BYTES);
  if (text === null) return json(413, { error: 'request body too large' }, route);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json(400, { error: 'body is not valid JSON' }, route);
  }
  const parsed = setMachineStatusBodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(400, { error: parsed.error.issues[0]?.message ?? 'bad status body' }, route);
  }
  if (!isUuid(machineId)) return json(404, { error: 'machine not found' }, route);

  try {
    const body = parsed.data;
    const r = await setMachineStatus(db, {
      machineId,
      status: body.status,
      reason: body.status === 'down' ? body.reason : null,
      appUserId: session.appUserId,
      byName: session.displayName,
    });
    switch (r.status) {
      case 'not_found':
        return json(404, { error: 'machine not found' }, route);
      case 'retired':
        return json(409, { error: 'this machine is retired' }, route);
      case 'saved': {
        const result: MachineStatusResult = r.result;
        return json(200, result, route);
      }
    }
  } catch (e) {
    console.error(`[${route}]`, (e as Error).message);
    return json(503, { error: 'the status could not be saved; try again' }, route);
  }
}
