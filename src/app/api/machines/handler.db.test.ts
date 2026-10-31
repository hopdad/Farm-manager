/**
 * The fleet panel routes against the real database, run as the sessions they serve: the list
 * (machines with and without a fix, down state, the geofence they are in), and marking a
 * machine down / back up (roles checked first on the server, body checks, retired and unknown
 * machines, publish of fleet/machine + fleet/invalidate in the same transaction).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { listenAppEvents } from '@/connectors/testkit';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import type { Role, Session } from '@/platform/auth/types';
import { setupTestDb } from '@/test/db';
import {
  type FleetPanelData,
  fleetPanelDataSchema,
  MAX_DOWN_REASON_CHARS,
  machineStatusResultSchema,
} from '@/ui/fleet/contract';
import { handleListMachines, handleSetMachineStatus } from './handler';

const t = setupTestDb(import.meta.url);

const cfg = () => ({
  APP_ENV: 'development' as const,
  NEXT_PUBLIC_REALTIME: 'sse' as const,
  FLEET_STALE_SECONDS: 600,
  FLEET_STALE_SECONDS_DEERE: 900,
  CONNECTOR_DEERE: 'replay' as const,
  CONNECTOR_SAMSARA: 'sim' as const,
  CONNECTOR_MOTIVE: 'off' as const,
  CONNECTOR_GEOTAB: 'off' as const,
  CONNECTOR_AEMP: 'off' as const,
  CONNECTOR_CNH: 'off' as const,
  CONNECTOR_TERMINAL: 'off' as const,
});

let combine: string;
let semi: string;
let retired: string;
let dana: string;
let elevator: string;
let listener: Awaited<ReturnType<typeof listenAppEvents>>;

const as = (role: Role | null, extra: Partial<Session> = {}) =>
  role === null ? null : makeSession({ role, displayName: `Test ${role}`, ...extra });

async function list(session: Session | null): Promise<{ status: number; body: unknown }> {
  const res = await runWithSession(session, () => handleListMachines(t().pool, cfg));
  return { status: res.status, body: await res.json() };
}

function statusRequest(
  id: string,
  body: unknown,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): Request {
  return new Request(`http://localhost:3104/api/machines/${id}/status`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function post(
  session: Session | null,
  id: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await runWithSession(session, () =>
    handleSetMachineStatus(statusRequest(id, body, headers), id, t().db),
  );
  expect(res.headers.get('cache-control')).toBe('no-store');
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function machineRow(id: string) {
  const r = await t().pool.query(
    'select status, down_reason, down_at, down_by::text as down_by from farm.machines where id = $1',
    [id],
  );
  return r.rows[0];
}

beforeAll(async () => {
  const ins = async (kind: string, unit: string, status = 'active') =>
    (
      await t().pool.query<{ id: string }>(
        `insert into farm.machines (kind, unit_no, make, model, status)
         values ($1, $2, 'John Deere', 'X9', $3) returning id::text as id`,
        [kind, unit, status],
      )
    ).rows[0]?.id as string;
  combine = await ins('combine', 'C1');
  semi = await ins('semi', 'S1');
  retired = await ins('semi', 'S0', 'retired');
  const party = await t().pool.query<{ id: string }>(
    `insert into farm.parties (kind, display_name, roles) values ('person', 'Dana', '{crew}')
     returning id::text as id`,
  );
  dana = (
    await t().pool.query<{ id: string }>(
      `insert into farm.app_users (party_id, role) values ($1, 'driver') returning id::text as id`,
      [party.rows[0]?.id],
    )
  ).rows[0]?.id as string;
  elevator = (
    await t().pool.query<{ id: string }>(
      `insert into farm.geofences (kind, name, geom) values ('elevator', 'Kestrel Grain',
         extensions.ST_MakeEnvelope(-83.85, 41.83, -83.84, 41.84, 4326)) returning id::text as id`,
    )
  ).rows[0]?.id as string;
  await t().pool.query(
    `insert into farm.machine_state (machine_id, ts, geom, speed_mph, heading, activity,
       position_source)
     values ($1, now() - interval '20 seconds',
             extensions.ST_SetSRID(extensions.ST_MakePoint(-83.845, 41.835), 4326), 2, 90,
             'queued', 'eld')`,
    [semi],
  );
  await t().pool.query(
    `insert into farm.geofence_visits (machine_id, geofence_id, entered_at)
     values ($1, $2, now() - interval '5 minutes')`,
    [semi, elevator],
  );
  listener = await listenAppEvents(t().appUrl);
});
afterAll(async () => {
  await listener?.close();
});
beforeEach(async () => {
  await t().pool.query(
    `update farm.machines set status = 'active', down_reason = null, down_at = null,
       down_by = null where status <> 'retired'`,
  );
});

describe('GET /api/machines', () => {
  test('signed out: 401', async () => {
    expect((await list(null)).status).toBe(401);
  });

  test('a viewer sees every machine that is not retired, with fix, place and modes', async () => {
    const { status, body } = await list(as('viewer'));
    expect(status).toBe(200);
    const data = fleetPanelDataSchema.parse(body);
    expect(data.machines.map((m) => m.unitNo)).toEqual(['C1', 'S1']);
    expect(data.canMarkDown).toBe(false);
    expect(data.modes).toEqual({
      deere: 'replay',
      samsara: 'sim',
      motive: 'off',
      geotab: 'off',
      aemp: 'off',
      cnh: 'off',
      terminal: 'off',
    });
    expect(data.config).toEqual({
      appEnv: 'development',
      realtime: 'sse',
      staleAfterSeconds: 600,
      deereStaleAfterSeconds: 900,
    });
    const [c1, s1] = data.machines;
    expect(c1?.position).toBeNull(); // no fix yet: still listed (it can be marked down)
    expect(c1?.place).toBeNull();
    expect(s1?.position).toMatchObject({ activity: 'queued', positionSource: 'eld', speedMph: 2 });
    expect(s1?.place).toMatchObject({
      geofenceId: elevator,
      name: 'Kestrel Grain',
      kind: 'elevator',
    });
  });

  test('drivers and up may mark machines down', async () => {
    for (const role of ['driver', 'operator', 'manager', 'owner'] as const) {
      const data = (await list(as(role))).body as FleetPanelData;
      expect(data.canMarkDown).toBe(true);
    }
  });
});

describe('GET /api/machines: 1f faults, vendor badge and stats', () => {
  test('faults, vendor and kind of the fix, counters and levels, via, what is not reported', async () => {
    const ins = async (unit: string, kind: string, extra = '') =>
      (
        await t().admin.query<{ id: string }>(
          `insert into farm.machines (kind, unit_no, engine_hours, odometer_mi, telematics_via,
             kind_set_by)
           values ($1, $2, ${extra || 'null, null, null, $3'}) returning id::text as id`,
          extra ? [kind, unit] : [kind, unit, 'default'],
        )
      ).rows[0]?.id as string;
    const truck = await ins('S7', 'semi', `4312.0, 412300.4, null, 'vendor'`);
    const pickup = await ins('PU7', 'pickup', `null, null, 'ford_pro', 'admin'`);
    const loader = await ins('L7', 'loader', `1210.5, null, null, 'default'`);
    const state = (id: string, vendor: string, kind: string, codes: unknown, fuel: number | null) =>
      t().pool.query(
        `insert into farm.machine_state (machine_id, ts, geom, speed_mph, heading, activity,
           position_source, position_vendor, position_kind, fault_codes, fuel_pct, def_pct)
         values ($1, now() - interval '30 seconds',
                 extensions.ST_SetSRID(extensions.ST_MakePoint(-83.9, 41.9), 4326), 0, 0, 'idle',
                 'eld', $2, $3, $4::jsonb, $5, $6)`,
        [id, vendor, kind, JSON.stringify(codes), fuel, fuel === null ? null : 54.2],
      );
    const red = {
      code: 'J1939 SPN 110 FMI 0',
      severity: 'critical',
      description: 'Coolant hot',
      system: 'j1939',
      spn: 110,
      fmi: 0,
      lamps: { redStop: true },
      since: new Date(Date.now() - 600_000).toISOString(),
    };
    await state(truck, 'samsara', 'live', [red], 62);
    await state(pickup, 'samsara', 'live', [], 54);
    await state(loader, 'aemp_kubota', 'last_known', [{ junk: true }], null);

    const data = fleetPanelDataSchema.parse((await list(as('viewer'))).body);
    const by = new Map(data.machines.map((m) => [m.unitNo, m]));
    expect(by.get('S7')).toMatchObject({
      faults: [red],
      engineHours: 4312,
      odometerMi: 412300.4,
      fuelPct: 62,
      defPct: 54.2,
      via: null,
      kindSetBy: 'vendor',
      notReported: [],
      faultsNotReported: false,
      position: { vendor: 'samsara' },
    });
    expect(by.get('S7')?.position).not.toHaveProperty('positionKind');
    // The Ford pickup through Samsara: hours and odometer "not reported" (null, never 0).
    expect(by.get('PU7')).toMatchObject({
      faults: [],
      engineHours: null,
      odometerMi: null,
      via: 'ford_pro',
      kindSetBy: 'admin',
      faultsNotReported: false,
    });
    expect(by.get('PU7')?.notReported).toEqual(
      expect.arrayContaining(['engineHours', 'odometerMi']),
    );
    // Kubota on AEMP: a last-known fix; no fault system reported; a malformed summary reads none.
    expect(by.get('L7')).toMatchObject({
      faults: [],
      fuelPct: null,
      faultsNotReported: true,
      position: { vendor: 'aemp_kubota', positionKind: 'last_known' },
    });
    // A machine with no fix yet: nothing known about its route.
    expect(by.get('C1')).toMatchObject({ faults: [], notReported: [], faultsNotReported: false });
    await t().admin.query('delete from farm.machines where id = any($1::uuid[])', [
      [truck, pickup, loader],
    ]);
  });
});

describe('POST /api/machines/<id>/status', () => {
  test('signed out 401, a viewer 403, and nothing changes', async () => {
    expect((await post(null, combine, { status: 'down', reason: 'Flat tire' })).status).toBe(401);
    const v = await post(as('viewer'), combine, { status: 'down', reason: 'Flat tire' });
    expect(v.status).toBe(403);
    expect(v.body.required).toBe('driver');
    expect((await machineRow(combine))?.status).toBe('active');
  });

  test('a driver marks a machine down: stored, then fleet/machine + fleet/invalidate', async () => {
    const before = listener.messages.length;
    const r = await post(as('driver', { appUserId: dana, displayName: 'Dana' }), combine, {
      status: 'down',
      reason: '  Hydraulic leak  ',
    });
    expect(r.status).toBe(200);
    const result = machineStatusResultSchema.parse(r.body);
    expect(result).toMatchObject({
      machineId: combine,
      status: 'down',
      downReason: 'Hydraulic leak',
      by: 'Dana',
    });
    const row = await machineRow(combine);
    expect(row).toMatchObject({ status: 'down', down_reason: 'Hydraulic leak', down_by: dana });
    expect(row?.down_at).toBeInstanceOf(Date);
    await listener.settle();
    const sent = listener.messages.slice(before).filter((m) => m.topic === 'fleet');
    expect(sent.map((m) => m.event)).toEqual(['machine', 'invalidate']);
    expect(sent[0]?.payload).toMatchObject({ machineId: combine, status: 'down', by: 'Dana' });
    expect(sent[1]?.payload).toMatchObject({ event: 'machine', reason: 'changed' });
    expect((sent[1]?.payload.seq ?? 0) > (sent[0]?.payload.seq ?? 0)).toBe(true);

    const listed = fleetPanelDataSchema.parse((await list(as('viewer'))).body);
    expect(listed.machines.find((m) => m.id === combine)).toMatchObject({
      status: 'down',
      downReason: 'Hydraulic leak',
      downBy: 'Dana',
    });
  });

  test('a new reason keeps "down since"; back up clears it all; repeats publish nothing', async () => {
    const driver = as('driver');
    await post(driver, semi, { status: 'down', reason: 'Flat tire' });
    const first = await machineRow(semi);
    const changed = await post(driver, semi, {
      status: 'down',
      reason: 'Flat tire, waiting on parts',
    });
    expect(changed.body.downAt).toBe((first?.down_at as Date | undefined)?.toISOString());
    expect((await machineRow(semi))?.down_reason).toBe('Flat tire, waiting on parts');

    const up = await post(driver, semi, { status: 'active' });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ status: 'active', downReason: null, downAt: null });
    expect(await machineRow(semi)).toMatchObject({
      status: 'active',
      down_reason: null,
      down_at: null,
      down_by: null,
    });

    await listener.settle();
    const before = listener.messages.length;
    expect((await post(driver, semi, { status: 'active' })).status).toBe(200);
    await listener.settle();
    expect(listener.messages.slice(before).filter((m) => m.topic === 'fleet')).toEqual([]);
  });

  test('bad bodies: 400 (no reason, too long, unknown status, extra keys, not JSON)', async () => {
    const d = as('driver');
    for (const body of [
      { status: 'down' },
      { status: 'down', reason: '   ' },
      { status: 'down', reason: 'x'.repeat(MAX_DOWN_REASON_CHARS + 1) },
      { status: 'retired' },
      { status: 'active', reason: 'x', extra: 1 },
      'not json',
    ]) {
      expect((await post(d, combine, body)).status).toBe(400);
    }
    expect((await machineRow(combine))?.status).toBe('active');
  });

  test('415 for a non-JSON content type, 413 for a huge body, 403 cross-site', async () => {
    const d = as('driver');
    expect(
      (await post(d, combine, { status: 'active' }, { 'content-type': 'text/plain' })).status,
    ).toBe(415);
    expect((await post(d, combine, { status: 'down', reason: 'x'.repeat(20_000) })).status).toBe(
      413,
    );
    expect(
      (
        await post(
          d,
          combine,
          { status: 'active' },
          {
            'content-type': 'application/json',
            origin: 'http://evil.example',
            host: 'localhost:3104',
          },
        )
      ).status,
    ).toBe(403);
  });

  test('unknown or malformed machine 404; retired 409', async () => {
    const d = as('driver');
    expect(
      (await post(d, '00000000-0000-4000-8000-000000000000', { status: 'active' })).status,
    ).toBe(404);
    expect((await post(d, 'not-a-uuid', { status: 'active' })).status).toBe(404);
    expect((await post(d, retired, { status: 'down', reason: 'x' })).status).toBe(409);
  });
});
