/**
 * Contract tests: the LIVE Samsara client against the stand-in started in-process (random port,
 * stub world, injectable wall clock). Same schemas validate both sides.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import { createStubSimWorld } from '../../sim/vendors/stub-world';
import type { ConnectorConfig } from '../endpoints';
import { VendorHttpError, VendorNetworkError } from '../http';
import { SamsaraClient } from './client';
import { mapSamsaraPosition, mapSamsaraStat } from './mapper';
import { samsaraLocationsFeedSchema } from './schemas';

let wall = Date.parse('2026-10-29T12:00:02.000Z');
let sim: VendorSim;
let cfg: ConnectorConfig;
const sleep = async (ms: number) => {
  wall += ms;
};

function client(overrides: Partial<ConnectorConfig> = {}) {
  return SamsaraClient.forMode(
    'sim',
    { ...cfg, ...overrides },
    { sleep, now: () => new Date(wall), timeoutMs: 2000 },
  );
}

beforeAll(async () => {
  sim = await startVendorSim({
    createWorld: createStubSimWorld,
    port: 0,
    now: () => new Date(wall),
    tuning: { maxEventsPerPage: 60 },
  });
  cfg = { VENDOR_SIM_URL: sim.url, PUBLIC_URL: 'http://localhost:3103' };
});
afterAll(() => sim.close());
beforeEach(() => {
  sim.control.reset({ scenario: 'harvest-day' });
});

describe('Samsara locations feed (sim)', () => {
  test('first call: latest location per ELD vehicle and an initial cursor', async () => {
    const page = await client().locationsFeed(null);
    expect(samsaraLocationsFeedSchema.safeParse(page).success).toBe(true);
    expect(page.data.map((v) => v.name).sort()).toEqual(['GC1', 'S1', 'S2']);
    expect(page.data.every((v) => v.locations.length === 1)).toBe(true);
    expect(page.pagination.hasNextPage).toBe(false);
    expect(page.pagination.endCursor).not.toBe('');
    const s1 = page.data.find((v) => v.name === 'S1');
    const pos = mapSamsaraPosition({ id: s1?.id, name: 'S1', location: s1?.locations[0] })[0];
    expect(pos).toMatchObject({
      source: 'samsara',
      externalMachineId: 'stub-veh-s1',
      sourceOrg: '',
      positionSource: 'eld',
      speedMph: 50,
      ts: '2026-10-29T12:00:00.000Z', // wall clock, on the 5 s grid
    });
  });

  test('cursor paging: every grid instant exactly once, in order, across pages', async () => {
    const c = client();
    let cursor = (await c.pollPositions(null)).cursor;
    wall += 10 * 60_000; // ten minutes later: 120 instants x 3 vehicles
    const seen: string[] = [];
    let pages = 0;
    for (;;) {
      const r = await c.pollPositions(cursor);
      pages++;
      seen.push(...r.items.map((i) => i.externalId));
      cursor = r.cursor;
      if (!r.hasMore) break;
    }
    expect(pages).toBe(6); // 60 events per page = 20 instants of 3 vehicles
    expect(seen).toHaveLength(360);
    expect(new Set(seen).size).toBe(360);
    const s1 = seen
      .filter((id) => id.startsWith('stub-veh-s1:'))
      .map((id) => id.split(':').slice(1).join(':'));
    expect([...s1].sort()).toEqual(s1);
    // Nothing new right after catching up: same cursor, no items.
    const again = await c.pollPositions(cursor);
    expect(again.items).toEqual([]);
    expect(again.cursor).toBe(cursor);
  });

  test('out_of_order shuffles a page without changing its contents', async () => {
    const c = client();
    const cursor = (await c.pollPositions(null)).cursor;
    wall += 30_000;
    const plain = await c.pollPositions(cursor);
    sim.control.faults({ action: 'add', rule: { vendor: 'samsara', kind: 'out_of_order' } });
    const shuffled = await c.pollPositions(cursor);
    expect(shuffled.items.map((i) => i.externalId)).not.toEqual(
      plain.items.map((i) => i.externalId),
    );
    expect([...shuffled.items].map((i) => i.externalId).sort()).toEqual(
      [...plain.items].map((i) => i.externalId).sort(),
    );
    expect(shuffled.cursor).toBe(plain.cursor);
  });

  test('duplicate_page answers the previous page again and the cursor does not advance', async () => {
    const c = client();
    const first = await c.pollPositions(null);
    wall += 20_000;
    const second = await c.pollPositions(first.cursor);
    sim.control.faults({ action: 'add', rule: { vendor: 'samsara', kind: 'duplicate_page' } });
    wall += 20_000;
    const dup = await c.pollPositions(second.cursor);
    expect(dup.items).toEqual(second.items);
    expect(dup.cursor).toBe(second.cursor);
    sim.control.faults({ action: 'clear' });
    const next = await c.pollPositions(dup.cursor);
    expect(next.items.length).toBe(12); // 4 new instants x 3 vehicles
  });

  test('429 with a short Retry-After is honored in-process', async () => {
    sim.control.faults({
      action: 'add',
      rule: {
        vendor: 'samsara',
        kind: 'rate_limit',
        retryAfterSeconds: 1,
        until: new Date(wall + 500).toISOString(),
      },
    });
    const before = wall;
    const r = await client().pollPositions(null);
    expect(r.items.length).toBe(3);
    expect(wall - before).toBe(1000); // waited exactly Retry-After
    expect(sim.counters.faults.rate_limit).toBeGreaterThanOrEqual(1);
  });

  test('429 with a long Retry-After surfaces retryAfterSeconds for the stream backoff', async () => {
    sim.control.faults({
      action: 'add',
      rule: { vendor: 'samsara', kind: 'rate_limit', retryAfterSeconds: 30 },
    });
    const err = await client()
      .pollPositions(null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorHttpError);
    expect(err).toMatchObject({ status: 429, retryAfterSeconds: 30 });
  });

  test('outage: the vendor is unreachable', async () => {
    sim.control.faults({
      action: 'add',
      rule: { vendor: 'samsara', kind: 'outage', label: 'trucks API down' },
    });
    const err = await client()
      .pollPositions(null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorNetworkError);
    expect((err as Error).message).toMatch(
      /^samsara \/samsara\/fleet\/vehicles\/locations\/feed: unreachable/,
    );
  });

  test('a wrong API token is a 401 (sandbox/live need SAMSARA_API_TOKEN)', async () => {
    const c = new SamsaraClient({ baseUrl: `${sim.url}/samsara`, apiToken: 'wrong' }, { sleep });
    await expect(c.pollPositions(null)).rejects.toMatchObject({ status: 401 });
    expect(() => SamsaraClient.forMode('live', cfg)).toThrow(/SAMSARA_API_TOKEN is required/);
  });
});

describe('Samsara stats feed (sim)', () => {
  test('engine seconds, fuel and odometer map to hours, percent and miles', async () => {
    const c = client();
    const first = await c.pollStats(null);
    expect(first.items.length).toBe(9); // 3 vehicles x 3 types, latest instant
    const s1 = first.items
      .filter((i) => i.payload.id === 'stub-veh-s1')
      .flatMap((i) => mapSamsaraStat(i.payload));
    const merged = Object.assign({}, ...s1);
    expect(merged.engineHours).toBeGreaterThan(1000);
    expect(merged.fuelPct).toBeGreaterThan(0);
    expect(merged.odometerMi).toBeGreaterThanOrEqual(50_000);
    wall += 3 * 60_000;
    const next = await c.pollStats(first.cursor);
    expect(next.items.length).toBe(27); // 3 new minutes
  });
});
