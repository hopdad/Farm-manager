/**
 * The board in REPLAY mode, end to end against the real database (plan 1a done-when
 * "CONNECTOR_DEERE=replay runs on the doc-derived fixtures"; contracts-m1 §10): the fleet.trucks
 * and fleet.deere jobs with CONNECTOR_SAMSARA=replay and CONNECTOR_DEERE=replay, no stand-in and no
 * network, on the demo farm as the seed writes it. Trucks and combines land in
 * farm.machine_state at "now", each run publishes one fleet tick, the trucks move from run to run,
 * and their hauls into the elevator yards become geofence visits.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fleetSnapshot, staleThresholdsOf } from '../../db/queries/fleet';
import { geofences } from '../../db/schema';
import { type FleetTick, fleetTickSchema } from '../../domain/fleet';
import { createFleetDeereJob, createFleetTrucksJob, type FleetConfig } from '../../jobs/fleet';
import { buildDemoFarm } from '../../sim/farm/build';
import { fieldEntranceGeofences } from '../../sim/farm/geofences';
import { setupTestDb } from '../../test/db';
import { listenAppEvents, seedSimFarm, testJobContext } from '../testkit';

const t = setupTestDb(import.meta.url);
const farm = buildDemoFarm();

let wall = Date.parse('2026-11-30T15:00:00.000Z');
const now = () => new Date(wall);
const cfg: FleetConfig = {
  VENDOR_SIM_URL: 'http://127.0.0.1:9', // nothing listens: replay must not need the stand-in
  PUBLIC_URL: 'http://localhost:3104',
  TOKEN_ENC_KEY: 'ab'.repeat(32),
  CONNECTOR_SAMSARA: 'replay',
  CONNECTOR_MOTIVE: 'off',
  CONNECTOR_DEERE: 'replay',
  FLEET_STALE_SECONDS: 60,
  FLEET_STALE_SECONDS_DEERE: 900,
};
const http = { timeoutMs: 2_000, baseBackoffMs: 1, sleep: async () => {} };
const trucks = createFleetTrucksJob({ config: () => cfg, http });
const deere = createFleetDeereJob({ config: () => cfg, http });
const ctx = (name: string) => testJobContext(t(), { name, now });
let listener: Awaited<ReturnType<typeof listenAppEvents>>;

const unitOf = new Map(farm.machines.map((m) => [m.id, m.unitNo]));

async function lastTick(run: () => Promise<unknown>): Promise<FleetTick> {
  const before = listener.of('fleet', 'tick').length;
  await run();
  await listener.settle();
  const ticks = listener.of('fleet', 'tick').slice(before);
  expect(ticks).toHaveLength(1);
  const payload = ticks[0]?.payload;
  if (!payload) throw new Error('no fleet tick');
  const { seq: _seq, ...tick } = payload as unknown as FleetTick & { seq: number };
  return fleetTickSchema.parse(tick);
}

beforeAll(async () => {
  await seedSimFarm(t().adminDb, farm);
  for (const g of fieldEntranceGeofences(farm)) {
    await t().adminDb.insert(geofences).values({
      id: g.id,
      kind: g.kind,
      name: g.name,
      fieldId: g.fieldId,
      geom: g.geofence,
      source: 'demo',
      sourceId: g.key,
    });
  }
  listener = await listenAppEvents(t().appUrl);
});
afterAll(async () => {
  await listener?.close();
});

describe('replay mode on the board', () => {
  test('fleet.trucks: the four trucks at the poll time, one tick, stats landed', async () => {
    let result: unknown;
    const tick = await lastTick(async () => {
      result = await trucks(ctx('fleet.trucks'));
    });
    expect(result).toEqual({ items: 4 + 12 }); // 4 positions + 4 vehicles x 3 stat types
    const semis = tick.machines.filter((m) => m.kind === 'semi');
    expect(semis.map((m) => m.unitNo).sort()).toEqual(['S1', 'S2', 'S3', 'S4']);
    for (const m of semis) {
      expect(m.ts).toBe(now().toISOString());
      expect(m.positionSource).toBe('eld');
      expect(m.stale).toBe(false);
    }
    const hours = await t().pool.query<{ n: number }>(
      `select count(*)::int as n from farm.machines where kind = 'semi' and engine_hours > 0`,
    );
    expect(hours.rows[0]?.n).toBe(4);
  });

  test('fleet.deere: the working machines at their latest breadcrumb, no OAuth grant needed', async () => {
    wall += 7 * 60_000;
    const tick = await lastTick(() => deere(ctx('fleet.deere')));
    const deereFixes = tick.machines.filter((m) => m.positionSource === 'deere_working');
    expect(deereFixes.length).toBeGreaterThanOrEqual(2);
    for (const m of deereFixes) {
      expect(['combine', 'grain_cart']).toContain(m.kind);
      expect(m.activity).toBe('working');
      expect(Date.parse(m.ts)).toBeLessThanOrEqual(wall);
      expect(m.stale).toBe(false);
    }
    const grants = await t().pool.query('select count(*)::int as n from ingest.oauth_tokens');
    expect(grants.rows[0]?.n).toBe(0);
  });

  test('the trucks move run after run, and their hauls become geofence visits', async () => {
    const where = async () =>
      (
        await t().pool.query<{ machine_id: string; lng: number; lat: number }>(
          `select machine_id::text, extensions.ST_X(geom) as lng, extensions.ST_Y(geom) as lat
           from farm.machine_state`,
        )
      ).rows;
    const start = new Map((await where()).map((r) => [r.machine_id, `${r.lng},${r.lat}`]));
    for (let i = 0; i < 40; i++) {
      wall += 5_000;
      await trucks(ctx('fleet.trucks'));
    }
    const moved = (await where()).filter(
      (r) =>
        unitOf.get(r.machine_id)?.startsWith('S') &&
        start.get(r.machine_id) !== `${r.lng},${r.lat}`,
    );
    expect(moved.length).toBeGreaterThanOrEqual(2);
    const visits = await t().pool.query<{ unit: string; kind: string; open: boolean }>(
      `select m.unit_no as unit, g.kind, v.exited_at is null as open
         from farm.geofence_visits v
         join farm.machines m on m.id = v.machine_id
         join farm.geofences g on g.id = v.geofence_id`,
    );
    expect(visits.rows.some((v) => v.kind === 'elevator')).toBe(true);
    const snapshot = await fleetSnapshot(t().pool, now(), staleThresholdsOf(cfg));
    expect(snapshot.machines.filter((m) => m.kind === 'semi').every((m) => !m.stale)).toBe(true);
  });
});
