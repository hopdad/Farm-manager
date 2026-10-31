/**
 * Contract tests: the LIVE Terminal client against the Terminal stand-in (in-process, the demo
 * world, an injectable wall clock) and against the doc-derived replay fixtures. Per call:
 * connections (discovered with the secret key alone, the disconnected one left out; a pinned
 * token), history and latest locations (the 10 s grid, no jitter, Terminal's sync lag, history
 * before latest), stat logs and latest counters (metric → hours, miles), fault code events (the
 * knob: open → closed, every protocol and the two the client must not store as given), the
 * vehicle list, /providers; a disconnected connection, a fractional Retry-After, a wrong key.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { DELTA_FAULT_AGE_OUT_SECONDS, normalizedFaultSchema } from '../../domain/fault-codes';
import { createSimWorld } from '../../sim/index';
import {
  SIM_CREDENTIALS,
  SIM_TERMINAL_CONNECTION_ID,
  simTelematicsMachines,
} from '../../sim/types';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import {
  TERMINAL_SIM_CONNECTIONS_PATH,
  TERMINAL_SIM_FAULT_CODES_PATH,
  TERMINAL_SIM_RATE_LIMIT_PATH,
  TERMINAL_SIM_SYNC_PATH,
  type TerminalSimStatus,
} from '../../sim/vendors/terminal/control-types';
import { type ConnectorConfig, terminalEndpoint } from '../endpoints';
import { VendorHttpError } from '../http';
import { forgetTerminalConnections, TerminalClient } from './client';
import { ANCHOR as REPLAY_ANCHOR } from './fixtures/build';
import {
  mapTerminalFault,
  mapTerminalPosition,
  mapTerminalProviders,
  mapTerminalStat,
  mapTerminalVehicle,
} from './mapper';

const START = Date.parse('2026-10-15T14:00:03.000Z');
let wall = START;
let sim: VendorSim;
let cfg: ConnectorConfig;
let h3Id: string;
let h3MachineId: string;
const logs: { msg: string; data?: Record<string, unknown> }[] = [];

const http = { now: () => new Date(wall), timeoutMs: 2000, sleep: async () => {} };
const client = (opts: ConstructorParameters<typeof TerminalClient>[2] = {}) =>
  TerminalClient.forMode('sim', cfg, http, {
    log: (msg, data) => logs.push({ msg, data }),
    ...opts,
  });
const knob = async (path: string, body: unknown) => {
  const res = await fetch(`${sim.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status, path).toBe(200);
  return (await res.json()) as TerminalSimStatus;
};

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now: () => new Date(wall) });
  cfg = { VENDOR_SIM_URL: sim.url, PUBLIC_URL: 'http://localhost:3117' };
  const h3 = simTelematicsMachines(sim.world.farm, 'terminal')[0];
  h3Id = h3?.telematics?.id as string;
  h3MachineId = h3?.id as string;
});
afterAll(() => sim.close());
beforeEach(() => {
  wall = START;
  logs.length = 0;
  forgetTerminalConnections();
  sim.control.reset({ scenario: 'harvest-day' });
});

describe('Terminal (sim)', () => {
  test('connections are discovered with the secret key alone; the disconnected one is left out', async () => {
    const refs = await client().connections();
    expect(refs).toEqual([
      {
        id: SIM_TERMINAL_CONNECTION_ID,
        token: SIM_CREDENTIALS.terminal.connectionToken,
        providerCode: 'omnitracs-xrs',
        providerName: 'Omnitracs XRS',
      },
    ]);
    // A pinned token (TERMINAL_CONNECTION_TOKEN) names its connection through /connections/current.
    const pinned = new TerminalClient(
      {
        ...terminalEndpoint('sim', cfg),
        connectionToken: SIM_CREDENTIALS.terminal.connectionToken,
      },
      http,
    );
    expect((await pinned.connections()).map((c) => c.id)).toEqual([SIM_TERMINAL_CONNECTION_ID]);
  });

  test('positions: history (live, lagging) then the latest location (last known), on the 10 s grid', async () => {
    const c = client();
    const first = await c.pollPositions(null);
    const kinds = first.items.map((i) => i.payload.kind);
    expect(kinds.at(-1)).toBe('latest');
    expect(kinds.slice(0, -1).every((k) => k === 'history')).toBe(true);
    expect(kinds.length).toBeGreaterThan(100); // the 30 min the stand-in keeps, every 10 s
    // runSyncStep processes a run's events in external-id order: history sorts first.
    const ids = first.items.map((i) => i.externalId);
    expect([...ids].sort((a, b) => a.localeCompare(b, 'en-US'))).toEqual(ids);

    const mapped = first.items.flatMap((i) => mapTerminalPosition(i.payload));
    const latest = mapped.at(-1);
    const newestHistory = mapped.at(-2);
    expect(latest).toMatchObject({
      source: 'terminal',
      externalMachineId: h3Id,
      sourceOrg: SIM_TERMINAL_CONNECTION_ID,
      ts: '2026-10-15T14:00:00.000Z',
      positionKind: 'last_known',
      positionSource: 'eld',
      provider: 'omnitracs-xrs',
      speedMph: 0, // parked at the shop
      engineOn: false,
    });
    // Terminal stores a breadcrumb 10 s after the fact: the newest one is 10 s older.
    expect(newestHistory).toMatchObject({
      ts: '2026-10-15T13:59:50.000Z',
      positionKind: 'live',
      engineOn: null,
      provider: 'omnitracs-xrs',
    });
    const sample = sim.world.machineAt(h3MachineId, new Date(sim.status().clock.simNow));
    expect(latest?.lat).toBeCloseTo(sample?.lat ?? 0, 5);
    expect(latest?.lng).toBeCloseTo(sample?.lng ?? 0, 5);

    // 10 s later: one new breadcrumb and one new latest fix; nothing new within the same instant.
    wall += 10_000;
    const next = await c.pollPositions(first.cursor);
    expect(next.items.map((i) => [i.payload.kind, i.payload.location.locatedAt])).toEqual([
      ['history', '2026-10-15T14:00:00.000Z'],
      ['latest', '2026-10-15T14:00:10.000Z'],
    ]);
    expect((await c.pollPositions(next.cursor)).items).toEqual([]);
  });

  test('a stalled Terminal sync stops history, never the latest location; catching up lands the backlog', async () => {
    const c = client();
    const first = await c.pollPositions(null);
    await knob(TERMINAL_SIM_SYNC_PATH, { stalled: true });
    wall += 60_000;
    const stalled = await c.pollPositions(first.cursor);
    expect(stalled.items.map((i) => i.payload.kind)).toEqual(['latest']);
    wall += 30_000;
    await knob(TERMINAL_SIM_SYNC_PATH, { stalled: false });
    const caughtUp = await c.pollPositions(stalled.cursor);
    const history = caughtUp.items.filter((i) => i.payload.kind === 'history');
    // 14:00:00 … 14:01:20 were recorded meanwhile (stored only now).
    expect(history).toHaveLength(9);
    expect(history.at(-1)?.payload.location.locatedAt).toBe('2026-10-15T14:01:20.000Z');
  });

  test('stats: stat logs and the latest counters, metric → hours and miles; no fuel from Omnitracs XRS', async () => {
    const c = client();
    const r = await c.pollStats(null);
    const logs = r.items.filter((i) => i.payload.kind === 'log');
    const types = new Set(logs.map((i) => (i.payload.kind === 'log' ? i.payload.log.type : '')));
    expect(types).toEqual(new Set(['engine_state', 'odometer', 'engine_runtime']));
    const stats = r.items.flatMap((i) => mapTerminalStat(i.payload));
    const latest = stats.at(-1);
    const sample = sim.world.machineAt(h3MachineId, new Date(sim.status().clock.simNow));
    expect(latest?.engineHours).toBeCloseTo(sample?.engineHours ?? 0, 1);
    expect(latest?.odometerMi).toBeCloseTo(sample?.odometerMi ?? 0, 1);
    expect(latest?.engineOn).toBe(false);
    expect(latest?.fuelPct).toBeUndefined();
    expect(latest?.readings).toMatchObject({
      engineHours: { rawUnit: 'milliseconds', field: 'engineRuntime', adjusted: null },
      odometerMi: { rawUnit: 'kilometers', field: 'odometer', adjusted: null },
    });
    // Nothing new until a stat log is stored or a counter moves.
    expect((await c.pollStats(r.cursor)).items).toEqual([]);
  });

  test('faults: the knob opens and closes events that map to delta reports; the two odd ones are not stored as given', async () => {
    const c = client();
    expect((await c.pollFaults(null)).items).toEqual([]);
    await knob(TERMINAL_SIM_FAULT_CODES_PATH, { action: 'open', kind: 'j1939' });
    await knob(TERMINAL_SIM_FAULT_CODES_PATH, { action: 'open', kind: 'obdii', status: 'pending' });
    await knob(TERMINAL_SIM_FAULT_CODES_PATH, { action: 'open', kind: 'j1939_no_fmi' });
    await knob(TERMINAL_SIM_FAULT_CODES_PATH, { action: 'open', kind: 'j1939_bad_address' });
    // Terminal's sync stores them 10 s later.
    const early = await c.pollFaults(null);
    expect(early.items).toEqual([]);
    wall += 10_000;
    const opened = await c.pollFaults(early.cursor);
    expect(opened.items).toHaveLength(4);
    const stats = opened.items.flatMap((i) => mapTerminalFault(i.payload));
    expect(stats).toHaveLength(3); // the SPN with no FMI is skipped
    for (const s of stats) {
      expect(s).toMatchObject({
        source: 'terminal',
        externalMachineId: h3Id,
        sourceOrg: SIM_TERMINAL_CONNECTION_ID,
        faultReport: 'delta',
        faultAgeOutSeconds: DELTA_FAULT_AGE_OUT_SECONDS,
      });
      for (const f of s.faultCodes ?? []) normalizedFaultSchema.parse(f);
    }
    const faults = stats.flatMap((s) => s.faultCodes ?? []);
    expect(faults.map((f) => [f.code, f.severity, f.state, f.lamps?.malfunction ?? null])).toEqual([
      ['J1939 SPN 110 FMI 0', 'warning', 'open', true],
      ['P0217', 'warning', 'open', true],
      ['J1939 SPN 3031 FMI 9', 'info', 'open', false],
    ]);
    expect(faults[0]).toMatchObject({ spn: 110, fmi: 0, sourceAddress: 0, occurrenceCount: 3 });
    expect(faults[1]).toMatchObject({ system: 'obd2', dtc: 'P0217', vendorSeverity: 'pending' });
    expect(faults[2]?.sourceAddress).toBeNull(); // 256 is no J1939 address
    expect(faults[0]?.lastSeenAt).toBe('2026-10-15T14:00:03.000Z');

    // Nothing new until something changes; then the close.
    expect((await c.pollFaults(opened.cursor)).items).toEqual([]);
    wall += 5_000;
    await knob(TERMINAL_SIM_FAULT_CODES_PATH, { action: 'close', code: 'SPN110-FMI0' });
    wall += 10_000;
    const closed = await c.pollFaults(opened.cursor);
    const f = closed.items.flatMap((i) => mapTerminalFault(i.payload))[0]?.faultCodes?.[0];
    expect(f).toMatchObject({
      code: 'J1939 SPN 110 FMI 0',
      state: 'closed',
      closedAt: '2026-10-15T14:00:18.000Z',
    });
  });

  test('vehicles (no tags: group names only) and /providers rows', async () => {
    const c = client();
    const v = await c.pollVehicles(null);
    expect(v.items).toHaveLength(1);
    const [vehicle] = v.items.flatMap((i) => mapTerminalVehicle(i.payload));
    expect(vehicle).toMatchObject({
      source: 'terminal',
      sourceOrg: SIM_TERMINAL_CONNECTION_ID,
      externalId: h3Id,
      name: 'H3',
      tags: ['Hired trucks'],
      kindFromTags: null,
      via: null,
      make: 'Mack',
      model: 'Anthem',
      year: 2021,
    });
    expect((await c.pollVehicles(v.cursor)).items).toEqual([]);

    const p = await c.pollProviders(null);
    expect(p.items).toHaveLength(1);
    expect(p.items[0]?.payload.codes).toEqual(['omnitracs-xrs']);
    const [rows] = mapTerminalProviders(p.items[0]?.payload as never);
    expect(rows).toEqual([
      {
        code: 'omnitracs-xrs',
        label: 'Omnitracs XRS',
        vendorId: 'terminal_omnitracs_xrs',
        capabilities: {
          positions: { live: 'yes', lastKnown: 'yes' },
          stats: {
            engineHours: 'yes',
            odometerMi: 'yes',
            fuelPct: 'no',
            defPct: 'no',
            engineOn: 'yes',
          },
          faults: { j1939: 'doc', obd2: 'doc', oem: 'no' },
          fieldOperations: 'no',
          webhooks: 'no',
        },
      },
    ]);
  });

  test('only the mapped vehicles are asked for: a connection with none makes no data call', async () => {
    const before = sim.counters.requests.terminal ?? 0;
    const none = await client({ only: new Map() }).pollPositions(null);
    expect(none.items).toEqual([]);
    // GET /connections only.
    expect((sim.counters.requests.terminal ?? 0) - before).toBe(1);
    const mapped = await client({
      only: new Map([[SIM_TERMINAL_CONNECTION_ID, new Set([h3Id])]]),
    }).pollPositions(null);
    expect(mapped.items.length).toBeGreaterThan(0);
  });

  test('a disconnected connection is refused with 422 and logged; a wrong key is a 401', async () => {
    await knob(TERMINAL_SIM_CONNECTIONS_PATH, {
      connectionId: SIM_TERMINAL_CONNECTION_ID,
      status: 'disconnected',
    });
    // Discovery no longer lists it (status=connected).
    expect(await client().connections()).toEqual([]);
    // A client that still holds it (a cached discovery) is refused and says so.
    await knob(TERMINAL_SIM_CONNECTIONS_PATH, { status: 'connected' });
    forgetTerminalConnections();
    const c = client();
    await c.connections();
    await knob(TERMINAL_SIM_CONNECTIONS_PATH, { status: 'disconnected' });
    const err = await c.pollPositions(null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorHttpError);
    expect((err as VendorHttpError).status).toBe(422);
    expect(logs.some((l) => l.msg.includes('connection skipped'))).toBe(true);

    const bad = new TerminalClient({ ...terminalEndpoint('sim', cfg), secretKey: 'nope' }, http);
    const e401 = await bad.connections().catch((e: unknown) => e);
    expect((e401 as VendorHttpError).status).toBe(401);
    expect((e401 as VendorHttpError).detail).toBe('Unauthorized Request');
  });

  test('a fractional Retry-After: 0.62 s is waited out inline, 1.5 s rounds up to 2 s', async () => {
    const waits: number[] = [];
    const sleepy = { ...http, sleep: async (ms: number) => void waits.push(ms) };
    await knob(TERMINAL_SIM_RATE_LIMIT_PATH, { count: 1, retryAfter: '0.62' });
    const ok = await TerminalClient.forMode('sim', cfg, sleepy).connections();
    expect(ok).toHaveLength(1);
    expect(waits).toEqual([1000]);

    forgetTerminalConnections();
    await knob(TERMINAL_SIM_RATE_LIMIT_PATH, { count: 1, retryAfter: '1.5' });
    const err = await TerminalClient.forMode('sim', cfg, { ...sleepy, maxRetries: 0 })
      .connections()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorHttpError);
    expect((err as VendorHttpError).status).toBe(429);
    expect((err as VendorHttpError).retryAfterSeconds).toBe(2);
  });
});

describe('Terminal (replay)', () => {
  const replay = (now: number) =>
    TerminalClient.forMode('replay', cfg, { now: () => new Date(now), timeoutMs: 2000 });

  test('the doc-derived fixtures serve H3: connections, positions, stats, faults, vehicles, providers', async () => {
    const now = Date.parse(REPLAY_ANCHOR) + 3 * 86_400_000 + 4_000;
    const c = replay(now);
    const conns = await c.connections();
    expect(conns.map((x) => [x.id, x.providerCode])).toEqual([
      [SIM_TERMINAL_CONNECTION_ID, 'omnitracs-xrs'],
    ]);
    const pos = (await c.pollPositions(null)).items.flatMap((i) => mapTerminalPosition(i.payload));
    expect(pos.length).toBeGreaterThan(10);
    expect(new Set(pos.map((p) => p.externalMachineId))).toEqual(new Set([h3Id]));
    const latest = pos.at(-1);
    expect(latest?.positionKind).toBe('last_known');
    // Time-shifted to the call: the latest fix is "now" (to the 1 s step), history 10 s behind.
    expect(Math.abs(Date.parse(latest?.ts ?? '') - now)).toBeLessThan(5_000);
    expect(pos.at(-2)?.positionKind).toBe('live');

    const stats = (await c.pollStats(null)).items.flatMap((i) => mapTerminalStat(i.payload));
    expect(stats.some((s) => s.engineHours !== undefined && s.engineHours > 10_000)).toBe(true);
    expect(stats.some((s) => s.odometerMi !== undefined && s.odometerMi > 100_000)).toBe(true);

    const faults = (await c.pollFaults(null)).items.flatMap((i) => mapTerminalFault(i.payload));
    expect(faults.length).toBeGreaterThan(0);
    for (const f of faults.flatMap((s) => s.faultCodes ?? [])) normalizedFaultSchema.parse(f);

    const vehicles = (await c.pollVehicles(null)).items.flatMap((i) =>
      mapTerminalVehicle(i.payload),
    );
    expect(vehicles.map((v) => v.externalId)).toEqual([h3Id]);
    const providers = await c.pollProviders(null);
    expect(providers.items[0]?.payload.providers.map((p) => p.code)).toEqual(['omnitracs-xrs']);
  });
});
