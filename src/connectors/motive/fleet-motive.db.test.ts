/**
 * fleet.motive end to end (sim and replay): the live Motive client against the stand-in (the
 * demo world), the demo farm seeded with its external refs, and the real database through the
 * frozen writers (positionsUpsert / upsertPosition, statsUpsert / upsertVehicleStat,
 * applyVendorVehicle). H1 lands with its vendor id and kind, engine hours and odometer from the
 * true (adjusted) readings, ONE tick per run; the 1a seed's company-less ref and a ref under the
 * company id both map; faults land as raw delta reports (fleet-faults' writer stores them).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fleetTickSchema } from '../../domain/fleet';
import { createFleetMotiveJob } from '../../jobs/fleet-motive';
import type { FleetConfig } from '../../jobs/fleet-shared';
import { buildDemoFarm } from '../../sim/farm/build';
import { createSimWorld } from '../../sim/index';
import { simTelematicsMachines } from '../../sim/types';
import {
  MOTIVE_SIM_FAULT_CODES_PATH,
  SIM_MOTIVE_COMPANY_ID,
} from '../../sim/vendors/motive/control-types';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import { setupTestDb } from '../../test/db';
import { listenAppEvents, seedSimFarm, testJobContext } from '../testkit';

const t = setupTestDb(import.meta.url);
const farm = buildDemoFarm();
const h1 = simTelematicsMachines(farm, 'motive')[0];
const H1_ID = h1?.telematics?.id as string;

const base = Math.floor(Date.now() / 5_000) * 5_000 + 2_000;
let offset = 0;
const wall = () => new Date(base + offset);
let sim: VendorSim;
let cfg: FleetConfig;
let listener: Awaited<ReturnType<typeof listenAppEvents>>;

const http = { timeoutMs: 2000, baseBackoffMs: 5, sleep: async () => {} };
const motive = (over: Partial<FleetConfig> = {}) =>
  createFleetMotiveJob({ config: () => ({ ...cfg, ...over }), http });
const ctx = () => testJobContext(t(), { name: 'fleet.motive', now: wall });

async function state() {
  const r = await t().pool.query(
    `select s.ts, s.position_vendor, s.position_kind, s.position_source, s.fuel_pct,
            m.engine_hours::float8 as engine_hours, m.odometer_mi::float8 as odometer_mi,
            m.kind, m.kind_set_by
       from farm.machines m left join farm.machine_state s on s.machine_id = m.id
      where m.id = $1`,
    [h1?.id],
  );
  return r.rows[0];
}
const count = async (sql: string, args: unknown[] = []) =>
  Number((await t().pool.query(sql, args)).rows[0].n);

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now: wall });
  cfg = {
    VENDOR_SIM_URL: sim.url,
    PUBLIC_URL: 'http://localhost:3115',
    TOKEN_ENC_KEY: 'ef'.repeat(32),
    CONNECTOR_SAMSARA: 'off',
    CONNECTOR_MOTIVE: 'sim',
    CONNECTOR_DEERE: 'off',
    CONNECTOR_GEOTAB: 'off',
    FLEET_STALE_SECONDS: 60,
    FLEET_STALE_SECONDS_DEERE: 600,
  };
  await seedSimFarm(t().adminDb, farm);
  listener = await listenAppEvents(t().appUrl);
});
afterAll(async () => {
  await listener?.close();
  await sim?.close();
});

describe('fleet.motive (sim)', () => {
  test('a run lands H1: vendor id, kind, adjusted stats, ONE fresh tick', async () => {
    const ticksBefore = listener.of('fleet', 'tick').length;
    const r = await motive()(ctx());
    // positions (1) + stats (1) + vehicles (1); no fault records yet
    expect(r).toEqual({ items: 3 });
    await listener.settle();
    const ticks = listener.of('fleet', 'tick').slice(ticksBefore);
    expect(ticks).toHaveLength(1);
    const { seq: _seq, ...body } = (ticks[0]?.payload ?? {}) as Record<string, unknown>;
    const tick = fleetTickSchema.parse(body);
    const m = tick.machines.find((x) => x.unitNo === 'H1');
    expect(m).toMatchObject({ kind: 'semi', positionSource: 'eld', stale: false });
    const s = await state();
    expect(s).toMatchObject({
      position_vendor: 'motive',
      position_kind: 'live',
      position_source: 'eld',
      kind: 'semi',
      kind_set_by: 'vendor', // the "Semi" group
    });
    expect(s.ts.getTime() % 5_000).toBe(0); // the stand-in's 5 s grid
    const sample = sim.world.machineAt(h1?.id as string, new Date(sim.status().clock.simNow));
    expect(s.engine_hours).toBeCloseTo(sample?.engineHours ?? 0, 0); // true_engine_hours
    expect(s.odometer_mi).toBeCloseTo(sample?.odometerMi ?? 0, 0); // true_odometer, miles
    expect(s.fuel_pct).toBeGreaterThan(0);
    const streams = await t().pool.query(
      `select stream, mode, last_ok_at is not null as ok from ingest.sync_state
        where source = 'motive' order by stream`,
    );
    expect(streams.rows).toEqual(
      ['faults', 'positions', 'stats', 'vehicles'].map((stream) => ({
        stream,
        mode: 'sim',
        ok: true,
      })),
    );
    expect(listener.of('fleet', 'invalidate').some((x) => x.payload.reason === 'changed')).toBe(
      true,
    );
  });

  test('5 s later: a new fix (no jitter), stats unchanged, vehicles not due for an hour', async () => {
    offset += 5_000;
    const before = await state();
    const r = await motive()(ctx());
    expect(r).toEqual({ items: 1 });
    const after = await state();
    expect(after.ts.getTime() - before.ts.getTime()).toBe(5_000);
    expect(
      await count('select count(*) as n from farm.positions where machine_id = $1', [h1?.id]),
    ).toBe(2);
  });

  test('a ref under the company id maps too (the integrator moving H1 off the 1a ref)', async () => {
    await t().admin.query(
      `update ingest.external_refs set source_org = $1
        where source = 'motive' and kind = 'machine' and external_id = $2`,
      [SIM_MOTIVE_COMPANY_ID, H1_ID],
    );
    offset += 5_000;
    expect(await motive()(ctx())).toEqual({ items: 1 });
    await t().admin.query(
      `update ingest.external_refs set source_org = ''
        where source = 'motive' and kind = 'machine' and external_id = $1`,
      [H1_ID],
    );
  });

  test('a fault from the knob lands as a raw delta report and is processed', async () => {
    const res = await fetch(`${sim.url}${MOTIVE_SIM_FAULT_CODES_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'open', kind: 'obd2' }),
    });
    expect(res.status).toBe(200);
    offset += 5_000;
    await motive()(ctx());
    const raw = await t().pool.query(
      `select external_id, status, payload->'fault'->>'status' as fault_status
         from ingest.raw_events where source = 'motive' and stream = 'faults'`,
    );
    expect(raw.rows).toEqual([
      expect.objectContaining({ status: 'processed', fault_status: 'open' }),
    ]);
    expect(raw.rows[0]?.external_id).toMatch(new RegExp(`^${H1_ID}:fault:\\d+:open:`));
  });

  test('only mapped vehicles land; a Motive outage fails the run but still ticks', async () => {
    const ids = await t().pool.query(
      `select distinct split_part(external_id, ':', 1) as id from ingest.raw_events where source = 'motive'`,
    );
    expect(ids.rows.map((r) => r.id)).toEqual([H1_ID]);
    sim.control.faults({ action: 'add', rule: { id: 'down', vendor: 'motive', kind: 'outage' } });
    const ticksBefore = listener.of('fleet', 'tick').length;
    offset += 5_000;
    await expect(motive()(ctx())).rejects.toThrow(/motive .*unreachable/);
    await listener.settle();
    expect(listener.of('fleet', 'tick').length).toBe(ticksBefore + 1);
    sim.control.faults({ action: 'clear' });
  });

  test('CONNECTOR_MOTIVE=off claims nothing', async () => {
    expect(await motive({ CONNECTOR_MOTIVE: 'off' })(ctx())).toEqual({ items: 0, note: 'off' });
  });
});

describe('fleet.motive (replay)', () => {
  test('the doc-derived fixtures land H1, fresh, with its stats and faults', async () => {
    offset += 60_000;
    const before = await state();
    const r = await motive({ CONNECTOR_MOTIVE: 'replay' })(ctx());
    expect(r.items).toBeGreaterThanOrEqual(1);
    const after = await state();
    expect(after.position_vendor).toBe('motive');
    expect(after.ts.getTime()).toBeGreaterThan(before.ts.getTime());
    expect(Math.abs(after.ts.getTime() - wall().getTime())).toBeLessThan(1_000); // shifted to now
    const faults = await count(
      `select count(*) as n from ingest.raw_events where source = 'motive' and stream = 'faults'
         and payload->'fault'->>'id' in ('51204', '51198')`,
    );
    expect(faults).toBe(2);
  });
});
