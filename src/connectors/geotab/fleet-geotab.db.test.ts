/**
 * fleet.geotab end to end (sim and replay): the live MyGeotab client against the stand-in (the
 * demo world), the demo farm seeded with its external refs, and the real database through the
 * frozen writers. The session lives in ingest.oauth_tokens (source `geotab`, encrypted) and is
 * reused by the next run (one Authenticate); each entity type resumes from its own stored
 * toVersion; StatusData lands only our diagnostics; H2 gets its vendor id, engine hours and
 * odometer; the limited-scope fallback says so in sync_state.extra.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFleetGeotabJob } from '../../jobs/fleet-geotab';
import type { FleetConfig } from '../../jobs/fleet-shared';
import { buildDemoFarm } from '../../sim/farm/build';
import { createSimWorld } from '../../sim/index';
import { simTelematicsMachines } from '../../sim/types';
import {
  GEOTAB_SIM_FAULTS_PATH,
  GEOTAB_SIM_SERVER_PATH,
  GEOTAB_SIM_STATUS_PATH,
  type GeotabSimStatus,
} from '../../sim/vendors/geotab/control-types';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import { setupTestDb } from '../../test/db';
import { listenAppEvents, seedSimFarm, testJobContext } from '../testkit';
import { resetGeotabCaches } from './client';
import { resetGeotabLimits } from './session';

const t = setupTestDb(import.meta.url);
const farm = buildDemoFarm();
const h2 = simTelematicsMachines(farm, 'geotab')[0];
const H2_ID = h2?.telematics?.id as string;

const base = Math.floor(Date.now() / 60_000) * 60_000 + 2_000;
let offset = 0;
const wall = () => new Date(base + offset);
let sim: VendorSim;
let cfg: FleetConfig;
let listener: Awaited<ReturnType<typeof listenAppEvents>>;

const http = { timeoutMs: 2000, baseBackoffMs: 5, sleep: async () => {} };
const geotab = (over: Partial<FleetConfig> = {}) =>
  createFleetGeotabJob({ config: () => ({ ...cfg, ...over }), http });
const ctx = () => testJobContext(t(), { name: 'fleet.geotab', now: wall });

const simStatus = async (): Promise<GeotabSimStatus> =>
  (await fetch(`${sim.url}${GEOTAB_SIM_STATUS_PATH}`)).json() as Promise<GeotabSimStatus>;
const knob = async (path: string, body: unknown) => {
  const res = await fetch(`${sim.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
};
async function state() {
  const r = await t().pool.query(
    `select s.ts, s.position_vendor, s.position_kind, s.fuel_pct,
            m.engine_hours::float8 as engine_hours, m.odometer_mi::float8 as odometer_mi,
            m.kind, m.kind_set_by
       from farm.machines m left join farm.machine_state s on s.machine_id = m.id
      where m.id = $1`,
    [h2?.id],
  );
  return r.rows[0];
}
const cursorOf = async (stream: string) =>
  (
    await t().pool.query(
      `select cursor from ingest.sync_state where source = 'geotab' and stream = $1`,
      [stream],
    )
  ).rows[0]?.cursor as string | undefined;

beforeAll(async () => {
  resetGeotabLimits();
  resetGeotabCaches();
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now: wall });
  cfg = {
    VENDOR_SIM_URL: sim.url,
    PUBLIC_URL: 'http://localhost:3115',
    TOKEN_ENC_KEY: 'ab'.repeat(32),
    CONNECTOR_SAMSARA: 'off',
    CONNECTOR_MOTIVE: 'off',
    CONNECTOR_DEERE: 'off',
    CONNECTOR_GEOTAB: 'sim',
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

describe('fleet.geotab (sim)', () => {
  test('the first run: "from now" cursors per entity type, the session stored encrypted', async () => {
    const r = await geotab()(ctx());
    expect(r).toEqual({ items: 1 }); // the vehicle list (H2's kind from the "Semi" group)
    for (const stream of ['positions', 'stats', 'faults']) {
      expect(await cursorOf(stream)).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(new Set([await cursorOf('positions'), await cursorOf('stats')]).size).toBe(2);
    const tokens = await t().pool.query(
      `select org_external_id, ciphertext from ingest.oauth_tokens where source = 'geotab'`,
    );
    expect(tokens.rows).toHaveLength(1);
    expect(tokens.rows[0]?.org_external_id).toMatch(/\/sim_farm\/sim-geotab-service$/);
    expect(tokens.rows[0]?.ciphertext).toMatch(/^v1\./);
    expect((await state()).kind_set_by).toBe('vendor');
  });

  test('20 s later: H2 on the board (every 5 s instant), ONE tick, the same session', async () => {
    offset += 20_000;
    const ticksBefore = listener.of('fleet', 'tick').length;
    const r = await geotab()(ctx());
    expect(r.items).toBe(4);
    await listener.settle();
    expect(listener.of('fleet', 'tick').length).toBe(ticksBefore + 1);
    const s = await state();
    expect(s).toMatchObject({ position_vendor: 'geotab', position_kind: 'live' });
    expect(s.ts.getTime() % 5_000).toBe(0);
    const n = await t().pool.query(
      'select count(*)::int as n from farm.positions where machine_id = $1',
      [h2?.id],
    );
    expect(n.rows[0]?.n).toBe(4);
    expect((await simStatus()).calls.authenticate).toBe(1);
  });

  test('a minute later: StatusData lands only our diagnostics; engine hours and odometer', async () => {
    offset += 61_000;
    await geotab()(ctx());
    const raw = await t().pool.query(
      `select distinct payload->'record'->'diagnostic'->>'id' as d
         from ingest.raw_events where source = 'geotab' and stream = 'stats' order by 1`,
    );
    expect(raw.rows.map((r) => r.d)).toEqual([
      'DiagnosticEngineHoursId',
      'DiagnosticFuelLevelId',
      'DiagnosticIgnitionId',
      'DiagnosticOdometerId',
    ]);
    const sample = sim.world.machineAt(h2?.id as string, new Date(sim.status().clock.simNow));
    const s = await state();
    expect(s.engine_hours).toBeCloseTo(sample?.engineHours ?? 0, 0);
    expect(s.odometer_mi).toBeCloseTo(sample?.odometerMi ?? 0, 0);
    expect(s.fuel_pct).toBeGreaterThan(0);
  });

  test('a restart resumes each feed from its stored toVersion, with no second Authenticate', async () => {
    resetGeotabLimits(); // a new process
    resetGeotabCaches();
    const before = await t().pool.query(
      'select count(*)::int as n, max(ts) as last from farm.positions where machine_id = $1',
      [h2?.id],
    );
    offset += 10_000;
    await geotab()(ctx());
    const after = await t().pool.query(
      'select count(*)::int as n, max(ts) as last from farm.positions where machine_id = $1',
      [h2?.id],
    );
    // Exactly the instants since the stored version: no gap, no repeat.
    const instants = (after.rows[0]?.last.getTime() - before.rows[0]?.last.getTime()) / 5_000;
    expect(after.rows[0]?.n - before.rows[0]?.n).toBe(instants);
    expect((await simStatus()).calls.authenticate).toBe(1);
  });

  test('a FaultData record from the knob lands decoded (J1939 SPN 110 FMI 0)', async () => {
    await knob(GEOTAB_SIM_FAULTS_PATH, { action: 'raise', kind: 'j1939' });
    offset += 10_000;
    await geotab()(ctx());
    const raw = await t().pool.query(
      `select status, payload->'diagnostic'->>'code' as spn, payload->'failureMode'->>'code' as fmi
         from ingest.raw_events where source = 'geotab' and stream = 'faults'`,
    );
    expect(raw.rows).toEqual([{ status: 'processed', spn: '110', fmi: '0' }]);
  });

  test('a limited-scope user: DeviceStatusInfo, the live fix kept, scopeFallback in extra', async () => {
    await knob(GEOTAB_SIM_SERVER_PATH, { limitedScope: true });
    offset += 10_000;
    await geotab()(ctx());
    const extra = await t().pool.query(
      `select stream, extra->>'scopeFallback' as f from ingest.sync_state
        where source = 'geotab' and stream in ('positions', 'stats') order by stream`,
    );
    expect(extra.rows).toEqual([
      { stream: 'positions', f: '1' },
      { stream: 'stats', f: '1' },
    ]);
    // A last-known snapshot never replaces a fresh live fix (decision 1f-11).
    expect((await state()).position_kind).toBe('live');
    await knob(GEOTAB_SIM_SERVER_PATH, { limitedScope: false });
    resetGeotabCaches(); // the hour until the next GetFeed probe has passed
    offset += 10_000;
    await geotab()(ctx());
    const back = await t().pool.query(
      `select extra->>'scopeFallback' as f from ingest.sync_state where source = 'geotab' and stream = 'positions'`,
    );
    expect(back.rows[0]?.f).toBe('0');
  });

  test('raw rows hold only the mapped device; CONNECTOR_GEOTAB=off claims nothing', async () => {
    const ids = await t().pool.query(
      `select distinct split_part(external_id, ':', 1) as id from ingest.raw_events where source = 'geotab'`,
    );
    expect(ids.rows.map((r) => r.id)).toEqual([H2_ID]);
    expect(await geotab({ CONNECTOR_GEOTAB: 'off' })(ctx())).toEqual({ items: 0, note: 'off' });
  });
});

describe('fleet.geotab (replay)', () => {
  test('the doc-derived fixtures land H2, fresh, with its readings and faults', async () => {
    offset += 120_000;
    // Replay starts its own feeds: forget sim's versions (a mode switch).
    await t().admin.query(`update ingest.sync_state set cursor = null where source = 'geotab'`);
    const r = await geotab({ CONNECTOR_GEOTAB: 'replay' })(ctx());
    expect(r.items).toBeGreaterThanOrEqual(1 + 4 + 2);
    const s = await state();
    expect(s.position_vendor).toBe('geotab');
    expect(Math.abs(s.ts.getTime() - wall().getTime())).toBeLessThan(1_000);
  });
});
