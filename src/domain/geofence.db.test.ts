/**
 * src/jobs/geofences.ts (geofence enter/exit detection) against the real database (farm_app).
 * It lives here because src/jobs/** may not import the test harness (src/test, biome seam rule).
 * Covered: in-order fixes take the fast path, late fixes rebuild their stretch, any arrival
 * order ends in the visits the pure rules derive from the sorted fixes, re-running changes
 * nothing, and two writers on one machine serialize on the advisory lock.
 */
import type { Polygon } from 'geojson';
import type pg from 'pg';
import { beforeEach, describe, expect, test } from 'vitest';
import type { NormalizedPosition } from '../connectors/types';
import { upsertPosition } from '../db/queries/fleet';
import { detectGeofenceVisits } from '../jobs/geofences';
import { setupTestDb } from '../test/db';
import { metresPerDegree } from '../test/fixtures';
import { deriveVisits, type FixInside, type GeofenceVisit } from './geofence';

const t = setupTestDb(import.meta.url);

const BASE_LNG = -83.95;
const BASE_LAT = 41.9;
const m = metresPerDegree(BASE_LAT);
/** A point `east`/`north` metres from the base. */
const pt = (east: number, north: number): [number, number] => [
  BASE_LNG + east / m.lng,
  BASE_LAT + north / m.lat,
];
/** A square geofence of `side` metres centred `east`/`north` metres from the base. */
function square(east: number, north: number, side: number): Polygon {
  const h = side / 2;
  const ring = [pt(east - h, north - h), pt(east + h, north - h), pt(east + h, north + h)];
  ring.push(pt(east - h, north + h));
  return { type: 'Polygon', coordinates: [[...ring, ring[0] as [number, number]]] };
}

const T0 = Date.parse('2026-11-30T13:00:00.000Z');
const MIN = 60_000;
const iso = (minute: number) => new Date(T0 + minute * MIN).toISOString();

let machineId: string;
let elevator: string;
let entrance: string;

async function insertGeofence(kind: string, name: string, geom: Polygon): Promise<string> {
  const r = await t().pool.query<{ id: string }>(
    `insert into farm.geofences (kind, name, geom)
     values ($1, $2, extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($3), 4326))
     returning id::text as id`,
    [kind, name, JSON.stringify(geom)],
  );
  return r.rows[0]?.id as string;
}

beforeEach(async () => {
  await t().pool.query('delete from farm.geofence_visits');
  await t().pool.query('delete from farm.positions');
  await t().pool.query('delete from farm.machine_state');
  await t().pool.query('delete from farm.machines');
  await t().pool.query('delete from farm.geofences');
  const r = await t().pool.query<{ id: string }>(
    `insert into farm.machines (kind, unit_no) values ('semi', 'S9') returning id::text as id`,
  );
  machineId = r.rows[0]?.id as string;
  // An elevator yard (200 m square at 1 km east) and a field entrance overlapping its west edge.
  elevator = await insertGeofence('elevator', 'Test elevator', square(1000, 0, 200));
  entrance = await insertGeofence('field_entrance', 'Test entrance', square(880, 0, 80));
});

/** Where the truck is at each minute of the test track (metres east of the base). */
const TRACK: Record<number, number> = {
  0: 0, // outside
  1: 600, // outside
  2: 860, // entrance only
  3: 910, // entrance + elevator (overlap)
  4: 1000, // elevator
  5: 1000, // elevator
  6: 1050, // elevator
  7: 1500, // outside
  8: 1000, // elevator again
  9: 2000, // outside
};

function fix(minute: number): NormalizedPosition {
  const [lng, lat] = pt(TRACK[minute] as number, 0);
  return {
    source: 'samsara',
    externalMachineId: 'v-s9',
    sourceOrg: '',
    ts: iso(minute),
    lng,
    lat,
    heading: 90,
    speedMph: 20,
    engineOn: true,
    positionSource: 'eld',
  };
}

/** What the positions step does for one fix: store it, then detect, in one transaction. */
async function record(minute: number, client?: pg.PoolClient) {
  const c = client ?? (await t().pool.connect());
  try {
    await c.query('begin');
    const stored = await upsertPosition(c, machineId, fix(minute));
    const result = stored.inserted ? await detectGeofenceVisits(c, machineId, iso(minute)) : null;
    await c.query('commit');
    return result;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    if (!client) c.release();
  }
}

async function storedVisits(): Promise<GeofenceVisit[]> {
  const r = await t().pool.query<{ geofence_id: string; entered_at: Date; exited_at: Date | null }>(
    `select geofence_id::text as geofence_id, entered_at, exited_at
       from farm.geofence_visits where machine_id = $1
      order by entered_at, geofence_id`,
    [machineId],
  );
  return r.rows.map((v) => ({
    geofenceId: v.geofence_id,
    enteredAt: v.entered_at.getTime(),
    exitedAt: v.exited_at?.getTime() ?? null,
  }));
}

const visit = (g: string, inMin: number, outMin: number | null): GeofenceVisit => ({
  geofenceId: g,
  enteredAt: T0 + inMin * MIN,
  exitedAt: outMin === null ? null : T0 + outMin * MIN,
});

/** The visits the pure rules derive from the given minutes, sorted. */
function expectedFor(minutes: number[]): GeofenceVisit[] {
  const inside = (min: number): string[] => {
    const x = TRACK[min] as number;
    const ids: string[] = [];
    if (x >= 900 && x <= 1100) ids.push(elevator);
    if (x >= 840 && x <= 920) ids.push(entrance);
    return ids.sort();
  };
  const fixes: FixInside[] = [...minutes]
    .sort((a, b) => a - b)
    .map((min) => ({ ts: T0 + min * MIN, inside: inside(min) }));
  return deriveVisits(fixes);
}

const order = (v: GeofenceVisit[]) =>
  [...v].sort((a, b) => a.enteredAt - b.enteredAt || (a.geofenceId < b.geofenceId ? -1 : 1));

describe('in order (the fast path)', () => {
  test('enter at the first fix inside, exit at the first fix outside; overlaps independent', async () => {
    const paths: string[] = [];
    for (let min = 0; min <= 9; min++) paths.push((await record(min))?.path ?? 'none');
    expect(paths.every((p) => p === 'fast')).toBe(true);
    expect(order(await storedVisits())).toEqual(
      order([visit(entrance, 2, 4), visit(elevator, 3, 7), visit(elevator, 8, 9)]),
    );
  });

  test('still inside at the newest fix: one open visit, then closed by the exit', async () => {
    for (const min of [0, 4, 5]) await record(min);
    expect(await storedVisits()).toEqual([visit(elevator, 4, null)]);
    await record(7);
    expect(await storedVisits()).toEqual([visit(elevator, 4, 7)]);
  });

  test('a duplicate fix is not stored again, and detecting twice changes nothing', async () => {
    for (const min of [0, 4, 5, 7]) await record(min);
    const before = await t().pool.query(
      'select id, exited_at, updated_at from farm.geofence_visits',
    );
    expect(await record(5)).toBeNull(); // upsertPosition: already stored
    const c = await t().pool.connect();
    try {
      await c.query('begin');
      const again = await detectGeofenceVisits(c, machineId, iso(5));
      await c.query('commit');
      expect(again.changed + again.opened + again.closed).toBe(0);
    } finally {
      c.release();
    }
    const after = await t().pool.query(
      'select id, exited_at, updated_at from farm.geofence_visits',
    );
    expect(after.rows).toEqual(before.rows);
  });

  test('a gap longer than 30 min closes the visit at the last fix inside', async () => {
    TRACK[100] = 1000;
    try {
      for (const min of [0, 4, 5, 100]) await record(min);
      expect(order(await storedVisits())).toEqual(
        order([visit(elevator, 4, 5), visit(elevator, 100, null)]),
      );
    } finally {
      delete TRACK[100];
    }
  });

  test('inactive geofences are ignored', async () => {
    await t().pool.query('update farm.geofences set active = false where id = $1', [entrance]);
    for (const min of [1, 2, 3, 4]) await record(min);
    expect(await storedVisits()).toEqual([visit(elevator, 3, null)]);
  });
});

describe('out of order (the stretch is rebuilt)', () => {
  test('a late fix outside splits an open visit', async () => {
    TRACK[45] = 1500; // between minute 4 and 5 the truck was outside
    try {
      for (const min of [0, 4, 5]) await record(min);
      expect(await storedVisits()).toEqual([visit(elevator, 4, null)]);
      const r = await recordAt(4.5);
      expect(r?.path).toBe('recompute');
      expect(order(await storedVisits())).toEqual(
        order([visit(elevator, 4, 4.5), visit(elevator, 5, null)]),
      );
    } finally {
      delete TRACK[45];
    }
  });

  test('a late fix inside bridges a gap: two visits become one (the first row kept)', async () => {
    TRACK[20] = 1000;
    TRACK[40] = 1000;
    try {
      for (const min of [4, 40]) await record(min);
      // 36 minutes apart: the gap rule made two visits
      expect(order(await storedVisits())).toEqual(
        order([visit(elevator, 4, 4), visit(elevator, 40, null)]),
      );
      const firstId = (
        await t().pool.query('select id from farm.geofence_visits where entered_at = $1', [iso(4)])
      ).rows[0]?.id;
      expect((await record(20))?.path).toBe('recompute');
      expect(await storedVisits()).toEqual([visit(elevator, 4, null)]);
      const kept = await t().pool.query('select id from farm.geofence_visits');
      expect(kept.rows.map((r) => r.id)).toEqual([firstId]);
    } finally {
      delete TRACK[20];
      delete TRACK[40];
    }
  });

  test('every arrival order ends in the visits of the sorted fixes', async () => {
    const minutes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const expected = order(expectedFor(minutes));
    // Deterministic shuffles (no Math.random: the same orders on every run).
    const orders = [
      [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
      [5, 0, 9, 2, 7, 4, 1, 8, 3, 6],
      [3, 4, 2, 5, 1, 6, 0, 7, 9, 8],
      [8, 1, 6, 3, 4, 9, 0, 2, 7, 5],
    ];
    for (const seq of orders) {
      await t().pool.query('delete from farm.geofence_visits');
      await t().pool.query('delete from farm.positions');
      for (const min of seq) await record(min);
      expect(order(await storedVisits())).toEqual(expected);
      const open = await t().pool.query(
        `select count(*)::int as n from farm.geofence_visits where exited_at is null`,
      );
      expect(open.rows[0]?.n).toBe(expected.filter((v) => v.exitedAt === null).length);
    }
  });

  test('in-order and out-of-order processing agree prefix by prefix', async () => {
    const seq = [2, 0, 6, 4, 8, 1, 3];
    const seen: number[] = [];
    for (const min of seq) {
      await record(min);
      seen.push(min);
      expect(order(await storedVisits())).toEqual(order(expectedFor(seen)));
    }
  });
});

describe('concurrency', () => {
  test('two writers on one machine serialize on the advisory lock', async () => {
    const a = await t().pool.connect();
    const b = await t().pool.connect();
    try {
      await record(0);
      await a.query('begin');
      await upsertPosition(a, machineId, fix(4));
      await detectGeofenceVisits(a, machineId, iso(4));
      // b's detection waits for a's lock; a commits afterwards.
      const second = (async () => {
        await b.query('begin');
        await upsertPosition(b, machineId, fix(5));
        await detectGeofenceVisits(b, machineId, iso(5));
        await b.query('commit');
      })();
      await new Promise((r) => setTimeout(r, 100));
      await a.query('commit');
      await second;
      expect(await storedVisits()).toEqual([visit(elevator, 4, null)]);
    } finally {
      a.release();
      b.release();
    }
  });
});

/** Record a fix at a fractional minute (TRACK key = minute * 10 for x.5). */
async function recordAt(minute: number) {
  const key = Number.isInteger(minute) ? minute : Math.round(minute * 10);
  const [lng, lat] = pt(TRACK[key] as number, 0);
  const ts = new Date(T0 + minute * MIN).toISOString();
  const c = await t().pool.connect();
  try {
    await c.query('begin');
    const stored = await upsertPosition(c, machineId, { ...fix(0), ts, lng, lat });
    const r = stored.inserted ? await detectGeofenceVisits(c, machineId, ts) : null;
    await c.query('commit');
    return r;
  } finally {
    c.release();
  }
}
