/**
 * fleet.terminal end to end (sim and replay): the live Terminal client against the stand-in (the
 * demo world), the demo farm seeded with its external refs, and the real database through the
 * frozen writers (positionsUpsert / upsertPosition, statsUpsert / upsertVehicleStat,
 * applyVendorVehicle). H3 lands with its vendor id `terminal_omnitracs_xrs`, a LIVE fix from
 * Terminal's history (the latest location, a last-known snapshot, never replaces it while it is
 * fresh), engine hours and odometer from the metric stat logs, ONE tick per run; when Terminal's
 * sync stalls the snapshot takes over, and the history wins again once it catches up; the
 * provider rows land in sync_state extra (merged); fault events land as raw delta reports.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fleetTickSchema } from '../../domain/fleet';
import type { FleetConfig } from '../../jobs/fleet-shared';
import { createFleetTerminalJob, readTerminalProviders } from '../../jobs/fleet-terminal';
import { buildDemoFarm } from '../../sim/farm/build';
import { createSimWorld } from '../../sim/index';
import { simTelematicsMachines } from '../../sim/types';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import {
  TERMINAL_SIM_FAULT_CODES_PATH,
  TERMINAL_SIM_SYNC_PATH,
} from '../../sim/vendors/terminal/control-types';
import { setupTestDb } from '../../test/db';
import { listenAppEvents, seedSimFarm, testJobContext } from '../testkit';
import { forgetTerminalConnections } from './client';

const t = setupTestDb(import.meta.url);
const farm = buildDemoFarm();
const h3 = simTelematicsMachines(farm, 'terminal')[0];

const base = Math.floor(Date.now() / 10_000) * 10_000 + 3_000;
let offset = 0;
const wall = () => new Date(base + offset);
let sim: VendorSim;
let cfg: FleetConfig;
let listener: Awaited<ReturnType<typeof listenAppEvents>>;

const http = { timeoutMs: 2000, baseBackoffMs: 5, sleep: async () => {} };
const terminal = (over: Partial<FleetConfig> = {}) =>
  createFleetTerminalJob({ config: () => ({ ...cfg, ...over }), http });
const ctx = (now = wall) => testJobContext(t(), { name: 'fleet.terminal', now });

async function state() {
  const r = await t().pool.query(
    `select s.ts, s.position_vendor, s.position_kind, s.position_source,
            m.engine_hours::float8 as engine_hours, m.odometer_mi::float8 as odometer_mi,
            m.kind, m.kind_set_by, m.telematics_via
       from farm.machines m left join farm.machine_state s on s.machine_id = m.id
      where m.id = $1`,
    [h3?.id],
  );
  return r.rows[0];
}
const count = async (sql: string, args: unknown[] = []) =>
  Number((await t().pool.query(sql, args)).rows[0].n);
async function knob(path: string, body: unknown) {
  const res = await fetch(`${sim.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now: wall });
  cfg = {
    VENDOR_SIM_URL: sim.url,
    PUBLIC_URL: 'http://localhost:3117',
    TOKEN_ENC_KEY: 'ef'.repeat(32),
    CONNECTOR_SAMSARA: 'off',
    CONNECTOR_MOTIVE: 'off',
    CONNECTOR_DEERE: 'off',
    CONNECTOR_TERMINAL: 'sim',
    FLEET_STALE_SECONDS: 60,
    FLEET_STALE_SECONDS_DEERE: 600,
    FLEET_STALE_SECONDS_LAST_KNOWN: 10_800,
  };
  await seedSimFarm(t().adminDb, farm);
  listener = await listenAppEvents(t().appUrl);
  forgetTerminalConnections();
});
afterAll(async () => {
  await listener?.close();
  await sim?.close();
});

describe('fleet.terminal (sim)', () => {
  test('a run lands H3: live history fix with its vendor id, metric stats, providers, ONE fresh tick', async () => {
    // Another writer's key in the same extra object survives (writers merge their own keys).
    await t().pool.query(
      `insert into ingest.sync_state (source, stream, mode, extra)
       values ('terminal', 'providers', 'sim', '{"otherWriter": 2}')`,
    );
    const ticksBefore = listener.of('fleet', 'tick').length;
    const r = await terminal()(ctx());
    expect(r.items).toBeGreaterThan(100); // the stand-in's 30 min of breadcrumbs + stat logs
    await listener.settle();
    const ticks = listener.of('fleet', 'tick').slice(ticksBefore);
    expect(ticks).toHaveLength(1);
    const { seq: _seq, ...body } = (ticks[0]?.payload ?? {}) as Record<string, unknown>;
    const m = fleetTickSchema.parse(body).machines.find((x) => x.unitNo === 'H3');
    expect(m).toMatchObject({ kind: 'semi', positionSource: 'eld', stale: false });
    expect(m?.positionKind).toBeUndefined(); // live

    const s = await state();
    expect(s).toMatchObject({
      position_vendor: 'terminal_omnitracs_xrs',
      position_kind: 'live',
      position_source: 'eld',
    });
    // The newest stored breadcrumb: 10 s behind the latest location (Terminal's sync lag).
    expect(s.ts.getTime() % 10_000).toBe(0);
    expect(base + offset - s.ts.getTime()).toBeLessThanOrEqual(23_000);
    const sample = sim.world.machineAt(h3?.id as string, new Date(sim.status().clock.simNow));
    expect(s.engine_hours).toBeCloseTo(sample?.engineHours ?? 0, 0);
    expect(s.odometer_mi).toBeCloseTo(sample?.odometerMi ?? 0, 0);
    // History became farm.positions rows; the last-known snapshot did not.
    expect(
      await count('select count(*) as n from farm.positions where machine_id = $1', [h3?.id]),
    ).toBeGreaterThan(100);

    const streams = await t().pool.query(
      `select stream, mode, last_ok_at is not null as ok, extra from ingest.sync_state
        where source = 'terminal' order by stream`,
    );
    expect(streams.rows.map((x) => [x.stream, x.mode, x.ok])).toEqual(
      ['faults', 'positions', 'providers', 'stats', 'vehicles'].map((n) => [n, 'sim', true]),
    );
    const providers = streams.rows.find((x) => x.stream === 'providers');
    expect(providers.extra.otherWriter).toBe(2);
    // sync-health's measured cost of the run, merged next to it.
    expect(providers.extra.callsPerRunMode).toBe('sim');
    expect(await readTerminalProviders(t().pool)).toEqual([
      expect.objectContaining({
        code: 'omnitracs-xrs',
        label: 'Omnitracs XRS',
        vendorId: 'terminal_omnitracs_xrs',
      }),
    ]);
    // The vehicle list carries no kind hint ("Hired trucks"): the seeded kind stays.
    expect(s).toMatchObject({ kind: 'semi', kind_set_by: 'default' });
  });

  test('15 s later: a newer live fix; the snapshot never replaces it while history is fresh', async () => {
    offset += 15_000;
    const before = await state();
    await terminal()(ctx());
    const s = await state();
    expect(s.position_kind).toBe('live');
    expect(s.ts.getTime()).toBeGreaterThan(before.ts.getTime());
  });

  test("Terminal's sync stalls: the latest location takes over once history is stale; history wins again after", async () => {
    await knob(TERMINAL_SIM_SYNC_PATH, { stalled: true });
    offset += 20_000;
    await terminal()(ctx());
    // The live fix is not stale yet (60 s threshold): the snapshot waits.
    expect((await state()).position_kind).toBe('live');
    offset += 60_000;
    await terminal()(ctx());
    const s = await state();
    expect(s.position_kind).toBe('last_known');
    expect(s.position_vendor).toBe('terminal_omnitracs_xrs');

    offset += 15_000;
    await knob(TERMINAL_SIM_SYNC_PATH, { stalled: false });
    offset += 10_000;
    await terminal()(ctx());
    expect((await state()).position_kind).toBe('live');
  });

  test('fault events land as raw delta reports, processed (fleet-faults stores them)', async () => {
    await knob(TERMINAL_SIM_FAULT_CODES_PATH, { action: 'open', kind: 'j1939' });
    offset += 15_000;
    await terminal()(ctx());
    const r = await t().pool.query(
      `select status, payload->'event'->>'code' as code, payload->'event'->>'status' as st
         from ingest.raw_events where source = 'terminal' and stream = 'faults'`,
    );
    expect(r.rows).toEqual([{ status: 'processed', code: 'SPN110-FMI0', st: 'open' }]);
  });

  test('an unmapped hauler vehicle is never asked for nor landed', async () => {
    await t().pool.query(
      `delete from ingest.external_refs where source = 'terminal' and kind = 'machine'`,
    );
    offset += 15_000;
    const before = await count(
      `select count(*) as n from ingest.raw_events where source = 'terminal' and stream = 'positions'`,
    );
    await terminal()(ctx());
    expect(
      await count(
        `select count(*) as n from ingest.raw_events where source = 'terminal' and stream = 'positions'`,
      ),
    ).toBe(before);
    await seedSimFarm(t().adminDb, farm);
  });
});

describe('fleet.terminal (replay)', () => {
  test('the doc-derived fixtures land H3 live with its vendor id, time-shifted to now', async () => {
    await t().pool.query(`delete from farm.machine_state where machine_id = $1`, [h3?.id]);
    const now = () => new Date(Date.now());
    await terminal({ CONNECTOR_TERMINAL: 'replay' })(ctx(now));
    const s = await state();
    expect(s).toMatchObject({
      position_vendor: 'terminal_omnitracs_xrs',
      position_kind: 'live',
    });
    expect(Math.abs(Date.now() - s.ts.getTime())).toBeLessThan(30_000);
    const modes = await t().pool.query(
      `select distinct mode from ingest.sync_state where source = 'terminal' and stream = 'positions'`,
    );
    expect(modes.rows).toEqual([{ mode: 'replay' }]);
  });
});
