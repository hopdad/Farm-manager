/**
 * upsertVehicleStat's counters and levels (slice 1f, docs/contracts-1f.md §5.3): hours and
 * odometer of every telematics source appended to farm.machine_hours and never moving
 * farm.machines back; fuel and DEF under the `stats_at` guard (an older reading never moves them
 * back); the engine state only from a stat newer than the state's fix.
 */
import { describe, expect, test } from 'vitest';
import type { NormalizedPosition, NormalizedVehicleStat } from '../../connectors/types';
import { setupTestDb } from '../../test/db';
import { machines } from '../schema';
import { upsertPosition, upsertVehicleStat } from './fleet';

const t = setupTestDb(import.meta.url);

async function machine(unitNo: string): Promise<string> {
  const [m] = await t()
    .db.insert(machines)
    .values({ kind: 'semi', unitNo })
    .returning({ id: machines.id });
  if (!m) throw new Error('insert failed');
  return m.id;
}

const iso = (min: number) =>
  new Date(Date.parse('2026-10-15T14:00:00.000Z') + min * 60_000).toISOString();
const stat = (min: number, over: Partial<NormalizedVehicleStat>): NormalizedVehicleStat => ({
  source: 'samsara',
  externalMachineId: 'v',
  sourceOrg: '',
  ts: iso(min),
  ...over,
});
const fix = (min: number, engineOn: boolean | null = null): NormalizedPosition => ({
  source: 'samsara',
  externalMachineId: 'v',
  sourceOrg: '',
  ts: iso(min),
  lng: -84.04,
  lat: 41.9,
  heading: 0,
  speedMph: 0,
  engineOn,
  positionSource: 'eld',
});

const counters = async (id: string) =>
  (
    await t().pool.query<{ engine_hours: number | null; odometer_mi: number | null }>(
      'select engine_hours::float8, odometer_mi::float8 from farm.machines where id = $1',
      [id],
    )
  ).rows[0];
const history = async (id: string) =>
  (
    await t().pool.query<{
      ts: Date;
      source: string;
      engine_hours: string | null;
      odometer_mi: string | null;
    }>(
      `select ts, source, engine_hours, odometer_mi from farm.machine_hours
        where machine_id = $1 order by ts, source`,
      [id],
    )
  ).rows.map((r) => ({
    ts: r.ts.toISOString(),
    source: r.source,
    hours: r.engine_hours === null ? null : Number(r.engine_hours),
    odometer: r.odometer_mi === null ? null : Number(r.odometer_mi),
  }));
const levels = async (id: string) =>
  (
    await t().pool.query<{
      fuel_pct: number | null;
      def_pct: number | null;
      stats_at: Date | null;
      engine_on: boolean | null;
    }>(
      'select fuel_pct, def_pct, stats_at, engine_on from farm.machine_state where machine_id = $1',
      [id],
    )
  ).rows[0];

describe('hours and odometer (every telematics source)', () => {
  test('appended to machine_hours per source; machines never move back', async () => {
    const id = await machine('S1');
    await upsertVehicleStat(t().pool, id, stat(1, { engineHours: 4312.04 }));
    // Samsara sends the odometer as its own event at the same instant: one row, both columns.
    await upsertVehicleStat(t().pool, id, stat(1, { odometerMi: 412_300.26 }));
    // An older reading (out of order) is history, but never moves the machine back.
    await upsertVehicleStat(t().pool, id, stat(0, { engineHours: 4311.5, odometerMi: 412_299 }));
    // Another source's reading of the same machine at the same time: its own row.
    await upsertVehicleStat(t().pool, id, {
      ...stat(1, { engineHours: 4312.9 }),
      source: 'motive',
    });
    expect(await counters(id)).toEqual({ engine_hours: 4312.9, odometer_mi: 412_300.3 });
    expect(await history(id)).toEqual([
      { ts: iso(0), source: 'samsara', hours: 4311.5, odometer: 412_299 },
      { ts: iso(1), source: 'motive', hours: 4312.9, odometer: null },
      { ts: iso(1), source: 'samsara', hours: 4312, odometer: 412_300.3 },
    ]);
    // The same reading again (a duplicate page): nothing changes, a stored value never changes.
    await upsertVehicleStat(t().pool, id, stat(1, { engineHours: 9999 }));
    expect((await history(id)).find((h) => h.source === 'samsara' && h.ts === iso(1))?.hours).toBe(
      4312,
    );
  });

  test('a negative or non-finite counter is not stored (the machine_hours CHECK)', async () => {
    const id = await machine('S2');
    await upsertVehicleStat(t().pool, id, stat(1, { engineHours: -1, odometerMi: Number.NaN }));
    expect(await history(id)).toEqual([]);
    expect(await counters(id)).toEqual({ engine_hours: null, odometer_mi: null });
  });
});

describe('fuel and DEF (the stats_at guard)', () => {
  test('a newer stat moves them, an older one never does; equal times both land', async () => {
    const id = await machine('S3');
    await upsertVehicleStat(t().pool, id, stat(1, { fuelPct: 50 })); // no state yet: nothing
    expect(await levels(id)).toBeUndefined();
    await upsertPosition(t().pool, id, fix(0));
    await upsertVehicleStat(t().pool, id, stat(5, { fuelPct: 62 }));
    await upsertVehicleStat(t().pool, id, stat(5, { defPct: 54.2 })); // same instant, own event
    expect(await levels(id)).toMatchObject({ fuel_pct: 62, def_pct: 54.2 });
    expect((await levels(id))?.stats_at?.toISOString()).toBe(iso(5));
    // Older readings (out of order): fuel and DEF stay.
    await upsertVehicleStat(t().pool, id, stat(3, { fuelPct: 90, defPct: 99 }));
    expect(await levels(id)).toMatchObject({ fuel_pct: 62, def_pct: 54.2 });
    // A newer fuel reading leaves DEF as it was; levels are clamped to 0-100.
    await upsertVehicleStat(t().pool, id, stat(6, { fuelPct: 140 }));
    expect(await levels(id)).toMatchObject({ fuel_pct: 100, def_pct: 54.2 });
    expect((await levels(id))?.stats_at?.toISOString()).toBe(iso(6));
  });
});

describe('engine state', () => {
  test('only from a stat newer than the fix', async () => {
    const id = await machine('S4');
    await upsertPosition(t().pool, id, fix(5, true));
    await upsertVehicleStat(t().pool, id, stat(4, { engineOn: false }));
    expect((await levels(id))?.engine_on).toBe(true);
    await upsertVehicleStat(t().pool, id, stat(6, { engineOn: false }));
    expect((await levels(id))?.engine_on).toBe(false);
  });
});
