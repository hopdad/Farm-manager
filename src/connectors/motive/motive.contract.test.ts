/**
 * Contract tests: the LIVE Motive client against the Motive stand-in (in-process, the demo world,
 * an injectable wall clock) and against the doc-derived replay fixtures. Per call: companies,
 * v3 (gateway units) and v2 locations, stats, fault codes (knob open → closed, each system),
 * the vehicle list; the 5 s report grid with no jitter; a wrong key.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { normalizedFaultSchema } from '../../domain/fault-codes';
import { createSimWorld } from '../../sim/index';
import { SIM_CREDENTIALS, simTelematicsMachines } from '../../sim/types';
import {
  MOTIVE_SIM_FAULT_CODES_PATH,
  MOTIVE_SIM_GATEWAY_PATH,
  type MotiveSimStatus,
  SIM_MOTIVE_COMPANY_ID,
} from '../../sim/vendors/motive/control-types';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import type { ConnectorConfig } from '../endpoints';
import { VendorHttpError } from '../http';
import { MotiveClient } from './client';
import { mapMotiveFault, mapMotivePosition, mapMotiveStat } from './mapper';

let wall = Date.parse('2026-10-15T14:00:02.000Z');
let sim: VendorSim;
let cfg: ConnectorConfig;
let h1Id: string;

const http = { now: () => new Date(wall), timeoutMs: 2000, sleep: async () => {} };
const client = () => MotiveClient.forMode('sim', cfg, http);
const knob = async (path: string, body: unknown) => {
  const res = await fetch(`${sim.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as MotiveSimStatus;
};

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now: () => new Date(wall) });
  cfg = { VENDOR_SIM_URL: sim.url, PUBLIC_URL: 'http://localhost:3115' };
  h1Id = simTelematicsMachines(sim.world.farm, 'motive')[0]?.telematics?.id as string;
});
afterAll(() => sim.close());
beforeEach(() => {
  wall = Date.parse('2026-10-15T14:00:02.000Z');
  sim.control.reset({ scenario: 'harvest-day' });
});

describe('Motive (sim)', () => {
  test('companies → sourceOrg; H1 from v3 (gateway), reported on the 5 s grid with no jitter', async () => {
    const c = client();
    expect(await c.companyId()).toBe(SIM_MOTIVE_COMPANY_ID);
    const first = await c.pollPositions(null);
    expect(first.items.map((i) => i.payload.api)).toEqual(['v3']);
    const p = mapMotivePosition(first.items[0]?.payload)[0];
    expect(p).toMatchObject({
      source: 'motive',
      externalMachineId: h1Id,
      sourceOrg: SIM_MOTIVE_COMPANY_ID,
      ts: '2026-10-15T14:00:00.000Z',
      speedMph: 0, // parked at the shop: kph 0
      engineOn: false,
      positionSource: 'eld',
    });
    const times: number[] = [Date.parse(p?.ts ?? '')];
    let cursor = first.cursor;
    for (let i = 0; i < 4; i++) {
      wall += 5_000;
      const r = await c.pollPositions(cursor);
      cursor = r.cursor;
      expect(r.items).toHaveLength(1);
      times.push(Date.parse(r.items[0]?.payload.location.located_at ?? ''));
    }
    expect(times.slice(1).map((t, i) => t - (times[i] as number))).toEqual([
      5000, 5000, 5000, 5000,
    ]);
    // Nothing new within the same grid instant.
    expect((await c.pollPositions(cursor)).items).toEqual([]);
  });

  test('a vehicle without a gateway is read from v2 (speed in mph, X-Metric-Units: false)', async () => {
    await knob(MOTIVE_SIM_GATEWAY_PATH, { vehicleId: h1Id, gateway: false });
    const r = await client().pollPositions(null);
    expect(r.items.map((i) => i.payload.api)).toEqual(['v2']);
    const loc = r.items[0]?.payload.location;
    expect(loc?.speed).toBe(0);
    expect(loc?.kph).toBeUndefined();
  });

  test('stats: the true (adjusted) engine hours and odometer, in hours and miles', async () => {
    const c = client();
    const r = await c.pollStats(null);
    expect(r.items).toHaveLength(1);
    const [s] = mapMotiveStat(r.items[0]?.payload);
    const h1 = simTelematicsMachines(sim.world.farm, 'motive')[0];
    const sample = sim.world.machineAt(h1?.id as string, new Date(sim.status().clock.simNow));
    expect(s).toMatchObject({ source: 'motive', sourceOrg: SIM_MOTIVE_COMPANY_ID });
    expect(s?.engineHours).toBeCloseTo(sample?.engineHours ?? 0, 0);
    expect(s?.odometerMi).toBeCloseTo(sample?.odometerMi ?? 0, 0); // miles, not km
    expect(s?.readings?.engineHours).toMatchObject({ adjusted: true, field: 'true_engine_hours' });
    expect(s?.readings?.odometerMi).toMatchObject({ adjusted: true, rawUnit: 'miles' });
    expect(s?.fuelPct).toBeGreaterThan(0);
    // Unchanged values: nothing new.
    expect((await c.pollStats(r.cursor)).items).toEqual([]);
  });

  test('a fault opened by the knob, then closed: delta items with the right system and times', async () => {
    const c = client();
    let cursor = (await c.pollFaults(null)).cursor;
    const opened = await knob(MOTIVE_SIM_FAULT_CODES_PATH, { action: 'open', kind: 'j1939' });
    const id = opened.faults[0]?.id as string;
    wall += 90_000;
    const r1 = await c.pollFaults(cursor);
    cursor = r1.cursor;
    const [open] = mapMotiveFault(r1.items[0]?.payload);
    expect(open).toMatchObject({
      externalMachineId: h1Id,
      sourceOrg: SIM_MOTIVE_COMPANY_ID,
      faultReport: 'delta',
      ts: '2026-10-15T14:01:00.000Z',
    });
    expect(normalizedFaultSchema.parse(open?.faultCodes?.[0])).toMatchObject({
      system: 'j1939',
      spn: 110,
      fmi: 0,
      sourceAddress: 0,
      severity: 'info',
      state: 'open',
      firstSeenAt: '2026-10-15T14:00:02.000Z',
      lastSeenAt: '2026-10-15T14:01:00.000Z',
    });
    // Still open a minute later: its last observation moved (a refresh).
    wall += 60_000;
    const r2 = await c.pollFaults(cursor);
    cursor = r2.cursor;
    expect(mapMotiveFault(r2.items[0]?.payload)[0]?.faultCodes?.[0]?.lastSeenAt).toBe(
      '2026-10-15T14:02:00.000Z',
    );
    await knob(MOTIVE_SIM_FAULT_CODES_PATH, { action: 'close', id });
    const r3 = await c.pollFaults(cursor);
    expect(mapMotiveFault(r3.items[0]?.payload)[0]?.faultCodes?.[0]).toMatchObject({
      state: 'closed',
      closedAt: '2026-10-15T14:02:32.000Z',
    });
    expect((await c.pollFaults(r3.cursor)).items).toEqual([]);
  });

  test('OBD-II and OEM fault kinds map to their systems and severities', async () => {
    await knob(MOTIVE_SIM_FAULT_CODES_PATH, { action: 'open', kind: 'obd2' });
    await knob(MOTIVE_SIM_FAULT_CODES_PATH, { action: 'open', kind: 'oem' });
    const r = await client().asTelematicsSource().faults(null);
    const byCode = Object.fromEntries(
      r.items.map((s) => [s.faultCodes?.[0]?.code, s.faultCodes?.[0]?.severity]),
    );
    expect(byCode).toEqual({ P0217: 'info', 'OEM D1234': 'critical' });
  });

  test('the vehicle list: H1 in the "Semi" group → kind semi', async () => {
    const v = await client().asTelematicsSource().vehicles();
    expect(v).toEqual([
      expect.objectContaining({
        externalId: h1Id,
        sourceOrg: SIM_MOTIVE_COMPANY_ID,
        tags: ['Semi'],
        kindFromTags: 'semi',
        make: 'Kenworth',
        year: 2020,
      }),
    ]);
  });

  test("a wrong key: Motive's 401", async () => {
    const bad = new MotiveClient(
      { baseUrl: `${sim.url}/motive`, apiKey: `${SIM_CREDENTIALS.motive.apiKey}-x` },
      http,
    );
    const err = await bad.pollPositions(null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorHttpError);
    expect(err).toMatchObject({ status: 401, detail: 'invalid API key' });
  });
});

describe('Motive (replay: doc-derived fixtures)', () => {
  const replay = (at: number) =>
    MotiveClient.forMode(
      'replay',
      { VENDOR_SIM_URL: 'http://127.0.0.1:1', PUBLIC_URL: 'http://x' },
      {
        now: () => new Date(at),
      },
    );

  test('H1 fresh on every poll, with stats, faults and its group', async () => {
    const t0 = Date.parse('2026-11-30T15:00:00.000Z');
    const a = replay(t0);
    const first = await a.asTelematicsSource().positions(null);
    expect(first.items).toEqual([
      expect.objectContaining({
        externalMachineId: h1Id,
        sourceOrg: SIM_MOTIVE_COMPANY_ID,
        ts: new Date(t0).toISOString(),
      }),
    ]);
    const raw = await a.pollPositions(null);
    const later = await replay(t0 + 5_000).pollPositions(raw.cursor);
    expect(later.items).toHaveLength(1); // time-shifted: a newer fix
    const stats = await a.asTelematicsSource().stats(null);
    expect(stats.items[0]?.readings?.engineHours?.field).toBe('true_engine_hours');
    const faults = await a.asTelematicsSource().faults(null);
    expect(faults.items.map((s) => [s.faultCodes?.[0]?.code, s.faultCodes?.[0]?.state])).toEqual([
      ['J1939 SPN 110 FMI 0', 'open'],
      ['P0217', 'closed'],
    ]);
    expect((await a.asTelematicsSource().vehicles())[0]?.kindFromTags).toBe('semi');
  });
});
