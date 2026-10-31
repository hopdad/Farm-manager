/**
 * Contract tests in REPLAY mode (contracts-m1 §10): the live Samsara client
 * (`SamsaraClient.forMode('replay')`) on the doc-derived fixtures, no stand-in, no network.
 * Time-shifting puts every fix at the moment of the poll; the cursor loop moves the trucks one
 * step per poll; the stats feed answers once, then nothing new.
 */
import { describe, expect, test } from 'vitest';
import { buildDemoFarm } from '../../sim/farm/build';
import { simTelematicsMachines } from '../../sim/types';
import type { ConnectorConfig } from '../endpoints';
import { REPLAY_ORIGIN } from '../replay';
import { SamsaraClient } from './client';
import { LOOP_PAGES } from './fixtures/build';
import { mapSamsaraFaults, mapSamsaraPosition, mapSamsaraStat } from './mapper';

const cfg: ConnectorConfig = {
  VENDOR_SIM_URL: 'http://127.0.0.1:1',
  PUBLIC_URL: 'http://localhost:3104',
};
const farm = buildDemoFarm();
const trucks = new Map(
  simTelematicsMachines(farm, 'samsara', { feed: 'vehicle' }).map((m) => [m.telematics?.id, m]),
);

/** The demo area (Lenawee + Monroe around Adrian and Blissfield). */
const inDemoArea = (lng: number, lat: number) =>
  lng > -84.5 && lng < -83.3 && lat > 41.6 && lat < 42.2;

function client(at: () => Date) {
  return SamsaraClient.forMode('replay', cfg, { now: at, timeoutMs: 2_000 });
}

describe('Samsara in replay mode', () => {
  test('talks to the replay origin with a fixed token, never the network', () => {
    const c = client(() => new Date());
    expect(c.endpoint.baseUrl).toBe(`${REPLAY_ORIGIN}/samsara`);
  });

  test('first poll: each truck once, stamped with the poll time, mapped and on the demo map', async () => {
    const now = new Date('2026-11-30T15:04:27.640Z');
    const r = await client(() => now).pollPositions(null);
    expect(r.items).toHaveLength(4);
    expect(r.hasMore).toBe(false);
    const positions = r.items.flatMap((i) => mapSamsaraPosition(i.payload));
    for (const p of positions) {
      expect(trucks.get(p.externalMachineId)?.kind).toBe('semi');
      expect(p.ts).toBe('2026-11-30T15:04:27.000Z'); // the anchor moved to now (1 s steps)
      expect(p.positionSource).toBe('eld');
      expect(inDemoArea(p.lng, p.lat)).toBe(true);
    }
    expect(r.cursor).toMatch(/^replay-loop-\d{4}$/);
  });

  test('each poll moves the trucks one step; the loop closes after one lap', async () => {
    let t = Date.parse('2026-11-30T15:00:00.000Z');
    const c = client(() => new Date(t));
    let r = await c.pollPositions(null);
    const start = r.items.map((i) => i.payload.location);
    const startCursor = r.cursor;
    let moved = 0;
    for (let i = 0; i < LOOP_PAGES; i++) {
      t += 5_000;
      const before = r.items.map((x) => x.payload.location);
      r = await c.pollPositions(r.cursor);
      const after = r.items.map((x) => x.payload.location);
      expect(after.every((l) => Date.parse(l.time) === t)).toBe(true);
      if (
        after.some(
          (l, k) => l.latitude !== before[k]?.latitude || l.longitude !== before[k]?.longitude,
        )
      ) {
        moved++;
      }
    }
    expect(r.cursor).toBe(startCursor);
    expect(r.items.map((i) => [i.payload.location.latitude, i.payload.location.longitude])).toEqual(
      start.map((l) => [l.latitude, l.longitude]),
    );
    expect(moved).toBeGreaterThan(LOOP_PAGES / 2); // trucks drive most of the hour
  });

  test('a cursor the fixture does not know (one saved in sim mode) starts the loop over', async () => {
    const c = client(() => new Date('2026-11-30T15:00:00Z'));
    const fresh = await c.pollPositions(null);
    const stray = await c.pollPositions('sim-cursor-from-yesterday');
    expect(stray.cursor).toBe(fresh.cursor);
  });

  test('replays within one step are byte-identical (raw-event dedupe holds)', async () => {
    const now = new Date('2026-11-30T15:00:00.300Z');
    const a = await client(() => now).locationsFeed(null);
    const b = await client(() => new Date(now.getTime() + 500)).locationsFeed(null);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('stats: engine hours, fuel and odometer once, then caught up', async () => {
    const now = new Date('2026-11-30T15:00:00Z');
    const c = client(() => now);
    const first = await c.pollStats(null);
    const stats = first.items.flatMap((i) => mapSamsaraStat(i.payload));
    expect(stats.filter((s) => s.engineHours !== undefined)).toHaveLength(4);
    expect(stats.filter((s) => s.fuelPct !== undefined)).toHaveLength(4);
    expect(stats.filter((s) => s.odometerMi !== undefined)).toHaveLength(4);
    expect(stats.every((s) => s.ts === '2026-11-30T15:00:00.000Z')).toBe(true);
    const next = await c.pollStats(first.cursor);
    expect(next.items).toEqual([]);
    expect(next.cursor).toBe(first.cursor);
  });

  test('fault codes: one reading per truck once (S3 critical, S2 warning), then caught up', async () => {
    const now = new Date('2026-11-30T15:00:30Z');
    const c = client(() => now);
    const first = await c.pollFaults(null);
    expect(first.items).toHaveLength(4);
    const stats = first.items.flatMap((i) => mapSamsaraFaults(i.payload));
    const byUnit = new Map(
      stats.map((s) => [trucks.get(s.externalMachineId)?.unitNo, s.faultCodes ?? []]),
    );
    expect(byUnit.get('S3')).toMatchObject([
      { code: 'J1939 SPN 110 FMI 0', severity: 'critical', lamps: { redStop: true } },
    ]);
    expect(byUnit.get('S2')).toMatchObject([{ code: 'J1939 SPN 3216 FMI 2', severity: 'warning' }]);
    expect(byUnit.get('S1')).toEqual([]);
    expect(byUnit.get('S4')).toEqual([]);
    // Time-shifted to the poll (60 s steps), like every other replayed instant.
    expect(stats.every((s) => s.ts === '2026-11-30T15:00:00.000Z')).toBe(true);
    const next = await c.pollFaults(first.cursor);
    expect(next.items).toEqual([]);
    expect(next.cursor).toBe(first.cursor);
    // The stats call never gets the fault fixture's answer, nor the other way round.
    const st = await c.pollStats(null);
    expect(st.items.every((i) => i.payload.type !== undefined)).toBe(true);
    expect(st.items).toHaveLength(12);
  });
});
