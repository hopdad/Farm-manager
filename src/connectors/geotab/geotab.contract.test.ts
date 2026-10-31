/**
 * Contract tests: the LIVE MyGeotab client against the Geotab stand-in (in-process, the demo
 * world, an injectable wall clock) and against the doc-derived replay fixtures (told apart by
 * body). Per call: Authenticate (once, reused, again after the sessions end), LoginResult.path,
 * GetFeed LogRecord / StatusData / FaultData resuming from each stored toVersion, the lookups,
 * Get Device and Group, both rate limits (the client never trips them; the stand-in answers HTTP
 * 200 + OverLimitException when something does), and the limited-scope fallback.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { normalizedFaultSchema } from '../../domain/fault-codes';
import { createSimWorld } from '../../sim/index';
import { SIM_CREDENTIALS, simTelematicsMachines } from '../../sim/types';
import {
  GEOTAB_SIM_FAULTS_PATH,
  GEOTAB_SIM_SERVER_PATH,
  GEOTAB_SIM_STATUS_PATH,
  type GeotabSimStatus,
} from '../../sim/vendors/geotab/control-types';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import type { ConnectorConfig } from '../endpoints';
import { MemoryTokenStore } from '../oauth/memory-store';
import { GeotabClient, resetGeotabCaches } from './client';
import { mapGeotabFault, mapGeotabPosition, mapGeotabStat } from './mapper';
import { resetGeotabLimits } from './session';

let wall = Date.parse('2026-10-15T14:00:02.000Z');
let sim: VendorSim;
let cfg: ConnectorConfig;
let h2Id: string;
let store: MemoryTokenStore;

const http = { now: () => new Date(wall), timeoutMs: 2000, sleep: async () => {} };
const client = () => GeotabClient.forMode('sim', cfg, http, { store });
const control = async <T = GeotabSimStatus>(path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${sim.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(res.status, path).toBe(200);
  return (await res.json()) as T;
};
const status = () => control(GEOTAB_SIM_STATUS_PATH);

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now: () => new Date(wall) });
  cfg = { VENDOR_SIM_URL: sim.url, PUBLIC_URL: 'http://localhost:3115' };
  h2Id = simTelematicsMachines(sim.world.farm, 'geotab')[0]?.telematics?.id as string;
});
afterAll(() => sim.close());
beforeEach(() => {
  wall += 3_600_000;
  sim.control.reset({ scenario: 'harvest-day' });
  store = new MemoryTokenStore('geotab', null, { now: () => new Date(wall) });
  resetGeotabLimits();
  resetGeotabCaches();
});

describe('MyGeotab (sim)', () => {
  test('LogRecord: from now, then every 5 s instant once, resuming from the stored toVersion', async () => {
    const first = await client().pollPositions(null);
    expect(first.items).toEqual([]); // "from now": empty data + a toVersion
    expect(first.cursor).toMatch(/^[0-9a-f]{16}$/);
    wall += 20_000;
    // A new client (a restart) resumes from the stored cursor.
    const r = await client().pollPositions(first.cursor);
    expect(r.items).toHaveLength(4);
    const ts = r.items.map((i) => Date.parse(i.payload.record.dateTime));
    expect(ts.slice(1).map((t, k) => t - (ts[k] as number))).toEqual([5000, 5000, 5000]);
    expect(ts.every((t) => t % 5000 === 0)).toBe(true);
    expect(mapGeotabPosition(r.items[0]?.payload)[0]).toMatchObject({
      source: 'geotab',
      externalMachineId: h2Id,
      sourceOrg: '',
      speedMph: 0,
      positionSource: 'eld',
    });
    expect((await client().pollPositions(r.cursor)).items).toEqual([]);
  });

  test('StatusData: only our diagnostics land; engine hours in seconds, odometer in meters', async () => {
    const c = client();
    const start = await c.pollStats(null);
    wall += 61_000;
    const r = await c.pollStats(start.cursor);
    const ids = r.items.map((i) => i.payload.record.diagnostic.id).sort();
    expect(ids).toEqual([
      'DiagnosticEngineHoursId',
      'DiagnosticFuelLevelId',
      'DiagnosticIgnitionId',
      'DiagnosticOdometerId',
    ]);
    const stats = r.items.flatMap((i) => mapGeotabStat(i.payload));
    const h2 = simTelematicsMachines(sim.world.farm, 'geotab')[0];
    const sample = sim.world.machineAt(h2?.id as string, new Date(sim.status().clock.simNow));
    const hours = stats.find((s) => s.engineHours !== undefined);
    expect(hours?.engineHours).toBeCloseTo(sample?.engineHours ?? 0, 0);
    expect(hours?.readings?.engineHours).toMatchObject({ rawUnit: 'seconds', adjusted: false });
    expect(stats.find((s) => s.odometerMi !== undefined)?.odometerMi).toBeCloseTo(
      sample?.odometerMi ?? 0,
      0,
    );
    expect(stats.find((s) => s.engineOn !== undefined)?.engineOn).toBe(false);
  });

  test('FaultData from the knob: J1939 red stop (critical), OBD-II P0135, then cleared', async () => {
    const c = client();
    const start = await c.pollFaults(null);
    const raised = await control(GEOTAB_SIM_FAULTS_PATH, { action: 'raise', kind: 'j1939' });
    await control(GEOTAB_SIM_FAULTS_PATH, { action: 'raise', kind: 'obd2' });
    const r = await c.pollFaults(start.cursor);
    const faults = r.items.flatMap((i) => mapGeotabFault(i.payload));
    expect(faults.map((f) => f.faultReport)).toEqual(['delta', 'delta']);
    expect(normalizedFaultSchema.parse(faults[0]?.faultCodes?.[0])).toMatchObject({
      system: 'j1939',
      spn: 110,
      fmi: 0,
      severity: 'critical',
      lamps: { redStop: true },
      state: 'open',
    });
    expect(faults[1]?.faultCodes?.[0]).toMatchObject({
      system: 'obd2',
      dtc: 'P0135',
      severity: 'warning',
    });
    wall += 30_000;
    await control(GEOTAB_SIM_FAULTS_PATH, { action: 'clear', id: raised.faults[0]?.id });
    const cleared = await c.pollFaults(r.cursor);
    expect(mapGeotabFault(cleared.items[0]?.payload)[0]?.faultCodes?.[0]).toMatchObject({
      code: 'J1939 SPN 110 FMI 0',
      state: 'closed',
    });
    expect((await status()).calls.get.Diagnostic).toBe(1); // the lookups are cached
  });

  test('one Authenticate serves every run; after the sessions end, exactly one more', async () => {
    await client().pollPositions(null);
    await client().pollStats(null);
    await client().pollFaults(null);
    expect((await status()).calls.authenticate).toBe(1);
    await control(GEOTAB_SIM_SERVER_PATH, { expireSessions: true });
    await client().pollPositions(null);
    await client().pollStats(null);
    const s = await status();
    expect(s.calls.authenticate).toBe(2);
    expect(s.sessions).toBe(1);
  });

  test('LoginResult.path: a host is called from then on; absent keeps the configured server', async () => {
    const port = new URL(sim.url).port;
    await control(GEOTAB_SIM_SERVER_PATH, { loginPath: `localhost:${port}` });
    await client().pollPositions(null);
    await client().pollStats(null);
    expect((await status()).calls.hosts).toEqual({
      [`127.0.0.1:${port}`]: 1,
      [`localhost:${port}`]: 2,
    });
    sim.control.reset({ scenario: 'harvest-day' });
    store = new MemoryTokenStore('geotab', null, { now: () => new Date(wall) });
    await control(GEOTAB_SIM_SERVER_PATH, { loginPath: null });
    await client().pollPositions(null);
    expect((await status()).calls.hosts).toEqual({ [`127.0.0.1:${port}`]: 2 });
  });

  test('both limits: polling every 10 s never trips them; a burst past them gets OverLimit', async () => {
    let cursor: string | null = null;
    for (let i = 0; i < 18; i++) {
      cursor = (await client().pollPositions(cursor)).cursor;
      wall += 10_000;
    }
    expect((await status()).calls.overLimit).toBe(0);
    // Something else spending the same user's budget (61 GetFeed in a minute): the stand-in
    // answers HTTP 200 + OverLimitException + Retry-After, which the client surfaces.
    const session = await client().session();
    const credentials = {
      database: session.database,
      userName: session.userName,
      sessionId: session.sessionId,
    };
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) {
      last = await fetch(`${sim.url}/geotab/apiv1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'GetFeed', params: { typeName: 'FaultData', credentials } }),
      });
    }
    expect(last?.status).toBe(200);
    expect(last?.headers.get('retry-after')).toMatch(/^\d+$/);
    const body = (await last?.json()) as { error?: { data?: { type?: string } } } | undefined;
    expect(body?.error?.data?.type).toBe('OverLimitException');
    resetGeotabLimits(); // the client's own window doesn't know about those calls
    const err = await client()
      .pollFaults(null)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ type: 'OverLimitException' });
    expect((err as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
  });

  test('a limited-scope user: GetFeed LogRecord/StatusData refused → DeviceStatusInfo (last known)', async () => {
    await control(GEOTAB_SIM_SERVER_PATH, { limitedScope: true });
    const c = client();
    const p = await c.asTelematicsSource().positions('00000000155cf8e0');
    expect(p.items).toEqual([
      expect.objectContaining({ externalMachineId: h2Id, positionKind: 'last_known' }),
    ]);
    const s = await c.asTelematicsSource().stats(null);
    expect(s.items.map((x) => Object.keys(x.readings ?? {})[0]).sort()).toEqual([
      'engineHours',
      'engineOn',
      'fuelPct',
      'odometerMi',
    ]);
    expect([...c.fallbacks].sort()).toEqual(['positions', 'stats']);
    // FaultData isn't restricted (11.119 names LogRecord and StatusData only).
    await expect(c.pollFaults(null)).resolves.toMatchObject({ items: [] });
  });

  test('the vehicle list: H2 in "Semi" → kind semi', async () => {
    const v = await client().asTelematicsSource().vehicles();
    expect(v).toEqual([
      expect.objectContaining({ externalId: h2Id, name: 'H2', kindFromTags: 'semi' }),
    ]);
  });

  test('wrong password: InvalidUserException, surfaced', async () => {
    const bad = GeotabClient.forMode(
      'sandbox',
      {
        ...cfg,
        GEOTAB_SERVER: new URL(sim.url).host,
        GEOTAB_DATABASE: SIM_CREDENTIALS.geotab.database,
        GEOTAB_USERNAME: SIM_CREDENTIALS.geotab.username,
        GEOTAB_PASSWORD: 'wrong',
      },
      http,
      { store },
    );
    // Sandbox builds https URLs: point it at the stand-in's http JSON-RPC path for this check.
    Object.assign(bad.endpoint, { apiUrl: `${sim.url}/geotab/apiv1` });
    await expect(bad.pollPositions(null)).rejects.toMatchObject({ type: 'InvalidUserException' });
  });
});

describe('MyGeotab (replay: doc-derived fixtures, told apart by body)', () => {
  const replay = (at: number) =>
    GeotabClient.forMode(
      'replay',
      { VENDOR_SIM_URL: 'http://127.0.0.1:1', PUBLIC_URL: 'http://x' },
      { now: () => new Date(at) },
    );

  test('H2 fresh on every poll; stats once; faults decoded; the vehicle list', async () => {
    const t0 = Date.parse('2026-11-30T15:00:00.000Z');
    const a = replay(t0).asTelematicsSource();
    const p = await a.positions(null);
    expect(p.items).toEqual([
      expect.objectContaining({ externalMachineId: h2Id, ts: new Date(t0).toISOString() }),
    ]);
    const later = await replay(t0 + 5_000)
      .asTelematicsSource()
      .positions(p.cursor);
    expect(later.items[0]?.ts).toBe(new Date(t0 + 5_000).toISOString());
    const s = await a.stats(null);
    expect(s.items).toHaveLength(4); // engine speed and coolant temperature dropped
    expect((await a.stats(s.cursor)).items).toEqual([]);
    const f = await a.faults(null);
    expect(
      f.items.map((x) => [
        x.faultCodes?.[0]?.code,
        x.faultCodes?.[0]?.severity,
        x.faultCodes?.[0]?.state,
      ]),
    ).toEqual([
      ['J1939 SPN 110 FMI 0', 'critical', 'open'],
      ['P0135', 'info', 'closed'],
    ]);
    expect((await a.faults(f.cursor)).items).toEqual([]);
    expect((await a.vehicles())[0]).toMatchObject({ externalId: h2Id, kindFromTags: 'semi' });
  });
});
