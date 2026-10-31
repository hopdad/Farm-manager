/**
 * Contract tests: the LIVE Samsara equipment-feed client against the stand-in (in-process, the
 * real demo world: the RoGator SP2 on an asset gateway) and against the replay fixtures. At most
 * 4 types per stats call, cursor paging, the `hoursFrom` / `silent` knobs, Samsara's per-path
 * rate limits with a fractional Retry-After.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createSimWorld } from '../../sim/index';
import { SIM_CREDENTIALS, simTelematicsMachines } from '../../sim/types';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import type { ConnectorConfig } from '../endpoints';
import { parseEquipmentStatsCursor, SamsaraEquipmentClient } from './equipment-client';
import { mapEquipmentPosition, mapEquipmentStat } from './equipment-mapper';

const NOW = Date.parse('2026-11-30T15:00:02.000Z');
let wall = NOW;
let sim: VendorSim;
let cfg: ConnectorConfig;
const http = { now: () => new Date(wall), sleep: async () => {}, timeoutMs: 5000 };

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now: () => new Date(wall) });
  cfg = { VENDOR_SIM_URL: sim.url, PUBLIC_URL: 'http://localhost:3116' };
});
afterAll(() => sim.close());
beforeEach(() => {
  wall = NOW;
  sim.control.reset({ scenario: 'harvest-day' });
});

const settings = (body: unknown) =>
  fetch(`${sim.url}/_control/vendor/samsara/equipment/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const sp2 = () => simTelematicsMachines(sim.world.farm, 'samsara', { feed: 'equipment' });

describe('Samsara equipment feeds (sim)', () => {
  test('only the asset-gateway machines; live fixes every 5 s after the first call', async () => {
    expect(sp2().map((m) => m.unitNo)).toEqual(['SP2']);
    const c = SamsaraEquipmentClient.forMode('sim', cfg, { http });
    const first = await c.pollPositions(null);
    expect(first.items).toHaveLength(1);
    const fix = mapEquipmentPosition(JSON.parse(JSON.stringify(first.items[0]?.payload)))[0];
    expect(fix).toMatchObject({
      source: 'samsara',
      externalMachineId: sp2()[0]?.telematics?.id,
      ts: '2026-11-30T15:00:00.000Z',
      positionSource: 'eld',
    });
    expect(fix?.positionKind).toBeUndefined(); // live
    wall += 60_000;
    const next = await c.pollPositions(first.cursor);
    expect(next.items).toHaveLength(12);
  });

  test('two stats calls of at most 4 types, each with its own cursor; obd hours preferred', async () => {
    const c = SamsaraEquipmentClient.forMode('sim', cfg, { http });
    const r = await c.pollStats(null);
    const cur = parseEquipmentStatsCursor(r.cursor);
    expect(Object.keys(cur.after).sort()).toEqual(['hours', 'state']);
    const stats = r.items.flatMap((i) => mapEquipmentStat(JSON.parse(JSON.stringify(i.payload))));
    const s = sim.world.machineAt(sp2()[0]?.id as string, new Date('2026-11-30T15:00:00.000Z'));
    const hours = stats.find((x) => x.engineHours !== undefined);
    expect(hours?.readings?.engineHours).toMatchObject({
      field: 'obdEngineSeconds',
      adjusted: false,
    });
    expect(hours?.engineHours).toBeCloseTo(s?.engineHours ?? 0, 1);
    expect(stats.find((x) => x.odometerMi !== undefined)?.readings?.odometerMi?.adjusted).toBe(
      true,
    );
    expect(stats.some((x) => typeof x.engineOn === 'boolean')).toBe(true);
    expect(stats.every((x) => x.defPct === undefined)).toBe(true); // no DEF on the feed
  });

  test('hoursFrom: only the J1939 offset count → adjusted engine hours', async () => {
    expect((await settings({ hoursFrom: ['j1939'] })).status).toBe(200);
    const c = SamsaraEquipmentClient.forMode('sim', cfg, { http });
    const r = await c.pollStats(null);
    const stats = r.items.flatMap((i) => mapEquipmentStat(JSON.parse(JSON.stringify(i.payload))));
    expect(stats.find((x) => x.engineHours !== undefined)?.readings?.engineHours).toMatchObject({
      field: 'gatewayJ1939EngineSeconds',
      adjusted: true,
    });
  });

  test('silent: the gateway stops reporting (no data, the cursor still moves)', async () => {
    const c = SamsaraEquipmentClient.forMode('sim', cfg, { http });
    const first = await c.pollPositions(null);
    expect((await settings({ silent: true })).status).toBe(200);
    wall += 30_000;
    const quiet = await c.pollPositions(first.cursor);
    expect(quiet.items).toEqual([]);
    expect(quiet.cursor).not.toBe(first.cursor);
  });

  test('more than 4 types or an unknown type is a 400; Samsara rate limits answer 429', async () => {
    const auth = { authorization: `Bearer ${SIM_CREDENTIALS.samsara.apiToken}` };
    const five = await fetch(
      `${sim.url}/samsara/fleet/equipment/stats/feed?types=gps,fuelPercents,engineRpm,obdEngineSeconds,gpsOdometerMeters`,
      { headers: auth },
    );
    expect(five.status).toBe(400);
    expect(((await five.json()) as { message: string }).message).toMatch(/At most 4/);
    const bad = await fetch(
      `${sim.url}/samsara/fleet/equipment/stats/feed?types=defLevelMilliPercent`,
      {
        headers: auth,
      },
    );
    expect(bad.status).toBe(400);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await fetch(`${sim.url}/samsara/fleet/equipment/locations/feed`, {
        headers: auth,
      });
      statuses.push(res.status);
      if (res.status === 429) {
        expect(res.headers.get('retry-after')).toMatch(/^\d+\.\d+$/);
      }
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});

describe('Samsara equipment feeds (replay)', () => {
  test('the doc-derived fixtures give SP2 a fresh live fix and its stats', async () => {
    wall = Date.parse('2026-11-30T15:00:07.000Z');
    const c = SamsaraEquipmentClient.forMode('replay', cfg, { http });
    const pos = await c.pollPositions(null);
    expect(pos.items).toHaveLength(1);
    expect(mapEquipmentPosition(pos.items[0]?.payload)[0]?.ts).toBe('2026-11-30T15:00:07.000Z');
    const stats = await c.pollStats(null);
    expect(stats.items).toHaveLength(2);
    const again = await c.pollStats(stats.cursor);
    expect(again.items).toEqual([]); // caught up
  });
});
