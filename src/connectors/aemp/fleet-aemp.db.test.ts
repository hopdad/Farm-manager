/**
 * fleet.aemp and fleet.equipment end to end in sim (the live clients against the stand-in with
 * the real demo world, the demo farm's machines and external refs, the real database):
 *  - L1 (Kubota on AEMP) lands as a LAST-KNOWN fix: machine_state only (no trail, no geofence
 *    visit), position_vendor `aemp_kubota`, engine hours in machines, not stale for 3 h;
 *  - SP2 (the RoGator on a Samsara asset gateway) lands LIVE from the equipment feed; its Samsara
 *    AEMP snapshot never replaces a fresh equipment-feed fix, and takes over once the gateway has
 *    been quiet longer than the live threshold (decision 1f-11);
 *  - each AEMP provider at most every minIntervalSeconds; the kubota fault series lands its
 *    occurrences; a fault that stops recurring closes a day after its last occurrence through
 *    the hourly polls alone (the age-out sweep, decision 1f-12), and a mode change closes the
 *    source's open codes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fleetSnapshot } from '../../db/queries/fleet';
import { AEMP_FAULTS_STREAM, AEMP_FLEET_STREAM, createFleetAempJob } from '../../jobs/fleet-aemp';
import { createFleetEquipmentJob } from '../../jobs/fleet-equipment';
import type { FleetConfig } from '../../jobs/fleet-shared';
import { buildDemoFarm } from '../../sim/farm/build';
import { createSimWorld } from '../../sim/index';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import { setupTestDb } from '../../test/db';
import { listenAppEvents, seedSimFarm, testJobContext } from '../testkit';

const t = setupTestDb(import.meta.url);
const farm = buildDemoFarm();
const unit = (u: string) => farm.machines.find((m) => m.unitNo === u)?.id as string;

/** 15:04:50 UTC: the AEMP samsara snapshot's Location (5 min grid) is 15:00:00. */
let wall = Date.parse('2026-11-30T15:04:50.000Z');
const now = () => new Date(wall);
let sim: VendorSim;
let cfg: FleetConfig;
let listener: Awaited<ReturnType<typeof listenAppEvents>>;
const http = { timeoutMs: 5000, baseBackoffMs: 5, sleep: async () => {} };
const aemp = () => createFleetAempJob({ config: () => cfg, http });
const equipment = () => createFleetEquipmentJob({ config: () => cfg, http });
const ctx = (name: string) => testJobContext(t(), { name, now });

async function state(u: string) {
  const r = await t().pool.query(
    `select position_vendor, position_kind, ts, engine_on from farm.machine_state where machine_id = $1`,
    [unit(u)],
  );
  return r.rows[0] as
    | { position_vendor: string; position_kind: string; ts: Date; engine_on: boolean | null }
    | undefined;
}
const count = async (sql: string, params: unknown[]) =>
  Number((await t().pool.query(sql, params)).rows[0].count);

const knob = (path: string, body: unknown) =>
  fetch(`${sim.url}/_control/vendor${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  sim = await startVendorSim({ createWorld: createSimWorld, port: 0, now });
  cfg = {
    VENDOR_SIM_URL: sim.url,
    PUBLIC_URL: 'http://localhost:3116',
    TOKEN_ENC_KEY: 'ef'.repeat(32),
    CONNECTOR_DEERE: 'off',
    CONNECTOR_SAMSARA: 'sim',
    CONNECTOR_MOTIVE: 'off',
    CONNECTOR_AEMP: 'sim',
    FLEET_STALE_SECONDS: 60,
    FLEET_STALE_SECONDS_DEERE: 900,
    FLEET_STALE_SECONDS_LAST_KNOWN: 10_800,
  };
  await seedSimFarm(t().adminDb, farm);
  listener = await listenAppEvents(t().appUrl);
});
afterAll(async () => {
  await listener?.close();
  await sim?.close();
});

describe('fleet.equipment then fleet.aemp (sim)', () => {
  test('SP2 live from the equipment feed: trail point, vendor samsara, engine hours', async () => {
    const r = await equipment()(ctx('fleet.equipment'));
    expect(r.items).toBeGreaterThan(0);
    expect(await state('SP2')).toMatchObject({ position_vendor: 'samsara', position_kind: 'live' });
    expect((await state('SP2'))?.ts.toISOString()).toBe('2026-11-30T15:04:50.000Z');
    expect(
      await count('select count(*) from farm.positions where machine_id = $1', [unit('SP2')]),
    ).toBe(1);
    const m = await t().pool.query(
      'select engine_hours, odometer_mi, telematics_via from farm.machines where id = $1',
      [unit('SP2')],
    );
    expect(Number(m.rows[0].engine_hours)).toBeGreaterThan(2400);
    expect(m.rows[0].telematics_via).toBe('gateway');
  });

  test('L1 last-known from AEMP kubota; the older SP2 snapshot leaves the live fix alone', async () => {
    const before = listener.of('fleet', 'tick').length;
    const r = await aemp()(ctx('fleet.aemp'));
    expect(r.items).toBeGreaterThan(0);
    expect(await state('L1')).toMatchObject({
      position_vendor: 'aemp_kubota',
      position_kind: 'last_known',
    });
    expect(
      await count('select count(*) from farm.positions where machine_id = $1', [unit('L1')]),
    ).toBe(0);
    expect(
      await count('select count(*) from farm.geofence_visits where machine_id = $1', [unit('L1')]),
    ).toBe(0);
    const l1 = await t().pool.query(
      'select engine_hours, odometer_mi from farm.machines where id = $1',
      [unit('L1')],
    );
    expect(Number(l1.rows[0].engine_hours)).toBeGreaterThan(1800);
    expect(l1.rows[0].odometer_mi).toBeNull(); // Kubota sends no Distance: never 0
    // The RoGator's AEMP snapshot (15:00) is older than its live fix (15:04:50): kept live.
    expect(await state('SP2')).toMatchObject({ position_vendor: 'samsara', position_kind: 'live' });
    await listener.settle();
    expect(listener.of('fleet', 'tick').length).toBe(before + 1);
    // On the board: L1 last-known and fresh (3 h threshold), SP2 live.
    const tick = await fleetSnapshot(t().pool, now(), {
      staleAfterSeconds: 60,
      deereStaleAfterSeconds: 900,
      lastKnownStaleAfterSeconds: 10_800,
    });
    expect(tick.machines.find((x) => x.unitNo === 'L1')).toMatchObject({
      positionKind: 'last_known',
      stale: false,
    });
    // sync_state.extra: each provider's last poll.
    const extra = await t().pool.query(
      `select extra from ingest.sync_state where source = 'aemp' and stream = $1`,
      [AEMP_FLEET_STREAM],
    );
    expect(extra.rows[0].extra).toMatchObject({
      providerErrors: 0,
      providers: { kubota: { polledAt: '2026-11-30T15:04:50.000Z' }, samsara: { error: null } },
    });
  });

  test('pacing: a run 5 minutes later polls no provider', async () => {
    wall += 5 * 60_000; // 15:09:50
    const calls = sim.counters.requests.aemp ?? 0;
    await aemp()(ctx('fleet.aemp'));
    expect(sim.counters.requests.aemp ?? 0).toBe(calls);
  });

  test('a newer snapshot within the live threshold of a fresh fix is still not applied', async () => {
    wall = Date.parse('2026-11-30T15:19:57.000Z');
    await equipment()(ctx('fleet.equipment')); // fix at 15:19:55
    wall = Date.parse('2026-11-30T15:20:05.000Z');
    await aemp()(ctx('fleet.aemp')); // due; SP2's Location at 15:20:00: 5 s newer
    expect(await state('SP2')).toMatchObject({ position_vendor: 'samsara', position_kind: 'live' });
    expect((await state('SP2'))?.ts.toISOString()).toBe('2026-11-30T15:19:55.000Z');
  });

  test('the gateway goes quiet: once the live fix is stale, the AEMP snapshot takes over', async () => {
    expect((await knob('/samsara/equipment/settings', { silent: true })).status).toBe(200);
    wall = Date.parse('2026-11-30T15:36:00.000Z');
    await equipment()(ctx('fleet.equipment')); // nothing new
    expect((await state('SP2'))?.ts.toISOString()).toBe('2026-11-30T15:19:55.000Z');
    await aemp()(ctx('fleet.aemp')); // Location 15:35:00, 15 min after the last live fix
    expect(await state('SP2')).toMatchObject({
      position_vendor: 'aemp_samsara',
      position_kind: 'last_known',
    });
    expect((await state('SP2'))?.ts.toISOString()).toBe('2026-11-30T15:35:00.000Z');
    // The gateway reports again: the live fix takes the machine back.
    expect((await knob('/samsara/equipment/settings', { silent: false })).status).toBe(200);
    wall += 10_000;
    await equipment()(ctx('fleet.equipment'));
    expect(await state('SP2')).toMatchObject({ position_vendor: 'samsara', position_kind: 'live' });
  });

  test('the kubota fault series: a raised fault lands and is processed on the faults stream', async () => {
    expect(
      (
        await knob('/aemp/faults', {
          action: 'add',
          machine: 'L1',
          code: 'SPN 110 FMI 0',
          severity: 'High',
        })
      ).status,
    ).toBe(200);
    wall += 16 * 60_000;
    await aemp()(ctx('fleet.aemp'));
    const raw = await t().pool.query(
      `select payload, status from ingest.raw_events where source = 'aemp' and stream = $1`,
      [AEMP_FAULTS_STREAM],
    );
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0]).toMatchObject({
      status: 'processed',
      payload: {
        provider: 'kubota',
        fault: { CodeIdentifier: 'SPN 110 FMI 0', CodeSeverity: 'High' },
      },
    });
  });

  test('a fault that stops recurring closes a day after its last occurrence (hourly polls alone)', async () => {
    const openL1 = async () =>
      (
        await t().pool.query<{ code: string; last_seen_at: Date; cleared_at: Date | null }>(
          `select code, last_seen_at, cleared_at from farm.machine_faults
            where machine_id = $1 order by first_seen_at`,
          [unit('L1')],
        )
      ).rows;
    const [raised] = await openL1();
    expect(raised).toMatchObject({ code: 'J1939 SPN 110 FMI 0', cleared_at: null });
    const lastSeen = (raised as { last_seen_at: Date }).last_seen_at.getTime();
    // The fault is repaired: the series reports no further occurrence. The job runs hourly.
    for (let h = 1; h <= 23; h++) {
      wall = lastSeen + h * 3_600_000;
      await aemp()(ctx('fleet.aemp'));
    }
    expect((await openL1())[0]?.cleared_at).toBeNull();
    const fleetPanel = async () =>
      (
        await t().pool.query('select fault_codes from farm.machine_state where machine_id = $1', [
          unit('L1'),
        ])
      ).rows[0]?.fault_codes;
    expect(await fleetPanel()).toMatchObject([{ code: 'J1939 SPN 110 FMI 0' }]);
    for (let h = 24; h <= 25; h++) {
      wall = lastSeen + h * 3_600_000;
      await aemp()(ctx('fleet.aemp'));
    }
    const [closed] = await openL1();
    expect(closed?.cleared_at?.toISOString()).toBe(new Date(lastSeen + 86_400_000).toISOString());
    expect(await fleetPanel()).toEqual([]);
  });

  test('a mode change closes the source codes an earlier mode raised', async () => {
    expect(
      (await knob('/aemp/faults', { action: 'add', machine: 'L1', code: 'SPN 100 FMI 1' })).status,
    ).toBe(200);
    wall += 16 * 60_000;
    await aemp()(ctx('fleet.aemp'));
    const open = async () =>
      Number(
        (
          await t().pool.query(
            `select count(*) from farm.machine_faults
              where source = 'aemp' and cleared_at is null`,
          )
        ).rows[0].count,
      );
    expect(await open()).toBe(1);
    // AEMP turned off (or switched to live, or from a replay run back to sim): closed.
    cfg = { ...cfg, CONNECTOR_AEMP: 'off' };
    wall += 60_000;
    await aemp()(ctx('fleet.aemp'));
    expect(await open()).toBe(0);
    const st = await t().pool.query(
      `select mode from ingest.sync_state where source = 'aemp' and stream = $1`,
      [AEMP_FAULTS_STREAM],
    );
    expect(st.rows[0]?.mode).toBe('off');
    cfg = { ...cfg, CONNECTOR_AEMP: 'sim' };
  });
});
