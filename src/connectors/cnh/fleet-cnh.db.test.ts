/**
 * fleet.cnh end to end in sim (the live client against the CNH stand-in with the real demo world,
 * the demo farm's machines and refs, the real database): the grant is created unattended and
 * stored encrypted (source cnh, the sim row); C3 and T1 land LIVE from the Locations trail
 * (position_vendor `cnh`), with hours and odometer from the Fleet snapshot; a machine whose
 * Locations are empty shows the snapshot's Location as LAST-KNOWN until a live fix arrives; a VIN
 * without the EULA is skipped and listed in sync_state.extra.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CNH_FAULTS_STREAM, CNH_POSITIONS_STREAM, createFleetCnhJob } from '../../jobs/fleet-cnh';
import type { FleetConfig } from '../../jobs/fleet-shared';
import { buildDemoFarm } from '../../sim/farm/build';
import { createSimWorld } from '../../sim/index';
import { startVendorSim, type VendorSim } from '../../sim/vendors/server';
import { setupTestDb } from '../../test/db';
import { SIM_GRANT_ORG } from '../oauth/token-store';
import { seedSimFarm, testJobContext } from '../testkit';

const t = setupTestDb(import.meta.url);
const farm = buildDemoFarm();
const unit = (u: string) => farm.machines.find((m) => m.unitNo === u)?.id as string;
const vin = (u: string) => farm.machines.find((m) => m.unitNo === u)?.telematics?.id as string;

let wall = Date.parse('2026-11-30T15:07:12.000Z');
const now = () => new Date(wall);
let sim: VendorSim;
let cfg: FleetConfig;
const http = { timeoutMs: 5000, baseBackoffMs: 5, sleep: async () => {} };
const job = () => createFleetCnhJob({ config: () => cfg, http });
const ctx = () => testJobContext(t(), { name: 'fleet.cnh', now });

const state = async (u: string) =>
  (
    await t().pool.query(
      'select position_vendor, position_kind, ts from farm.machine_state where machine_id = $1',
      [unit(u)],
    )
  ).rows[0] as { position_vendor: string; position_kind: string; ts: Date } | undefined;
const trail = async (u: string) =>
  Number(
    (await t().pool.query('select count(*) from farm.positions where machine_id = $1', [unit(u)]))
      .rows[0].count,
  );
const knob = (body: unknown) =>
  fetch(`${sim.url}/_control/vendor/cnh/settings`, {
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
    CONNECTOR_SAMSARA: 'off',
    CONNECTOR_MOTIVE: 'off',
    CONNECTOR_CNH: 'sim',
    FLEET_STALE_SECONDS: 60,
    FLEET_STALE_SECONDS_DEERE: 900,
    FLEET_STALE_SECONDS_LAST_KNOWN: 10_800,
  };
  await seedSimFarm(t().adminDb, farm);
});
afterAll(() => sim?.close());

describe('fleet.cnh (sim)', () => {
  test('first run: the grant stored; T1 live from Locations; C3 (no trail) last-known from the snapshot', async () => {
    expect((await knob({ locationsEmpty: ['C3'] })).status).toBe(200);
    const r = await job()(ctx());
    expect(r.items).toBeGreaterThan(0);
    const grant = await t().pool.query(
      `select org_external_id, scopes from ingest.oauth_tokens where source = 'cnh'`,
    );
    expect(grant.rows).toEqual([{ org_external_id: SIM_GRANT_ORG, scopes: ['offline_access'] }]);
    expect(await state('T1')).toMatchObject({ position_vendor: 'cnh', position_kind: 'live' });
    expect((await state('T1'))?.ts.toISOString()).toBe('2026-11-30T15:07:10.000Z');
    expect(await trail('T1')).toBe(180);
    expect(await state('C3')).toMatchObject({
      position_vendor: 'cnh',
      position_kind: 'last_known',
    });
    expect((await state('C3'))?.ts.toISOString()).toBe('2026-11-30T15:00:00.000Z');
    expect(await trail('C3')).toBe(0);
    // Hours and odometer from the snapshot (kilometres → miles).
    const m = await t().pool.query(
      'select unit_no, engine_hours, odometer_mi from farm.machines where id = any($1::uuid[]) order by unit_no',
      [[unit('C3'), unit('T1')]],
    );
    for (const row of m.rows) {
      expect(Number(row.engine_hours)).toBeGreaterThan(1400);
      expect(Number(row.odometer_mi)).toBeGreaterThan(3800);
    }
  });

  test('the trail comes back: a live fix replaces the last-known one', async () => {
    expect((await knob({ locationsEmpty: [] })).status).toBe(200);
    wall += 30_000;
    await job()(ctx());
    expect(await state('C3')).toMatchObject({ position_vendor: 'cnh', position_kind: 'live' });
    expect((await state('C3'))?.ts.toISOString()).toBe('2026-11-30T15:07:40.000Z');
  });

  test('a VIN without the EULA: skipped, logged once, listed in sync_state.extra', async () => {
    expect((await knob({ eulaMissing: ['T1'] })).status).toBe(200);
    wall += 5 * 60_000;
    const c = ctx();
    await job()(c);
    const warned = c.log.lines.filter((l) => l.level === 'warn' && /EULA/.test(l.msg));
    expect(warned.map((l) => l.data?.vin)).toEqual([vin('T1'), vin('T1')]); // positions + faults
    const before = (await state('T1'))?.ts.toISOString();
    expect(before).toBe('2026-11-30T15:07:40.000Z'); // no new fix for T1
    for (const stream of [CNH_POSITIONS_STREAM, CNH_FAULTS_STREAM]) {
      const extra = await t().pool.query(
        `select extra from ingest.sync_state where source = 'cnh' and stream = $1`,
        [stream],
      );
      expect(extra.rows[0].extra).toMatchObject({
        needsEulaCount: 1,
        needsEula: [{ vin: vin('T1'), reason: expect.stringMatching(/EULA not accepted/) }],
      });
    }
    // Listed once: a run 30 s later doesn't warn again.
    wall += 30_000;
    const again = ctx();
    await job()(again);
    expect(again.log.lines.filter((l) => /EULA/.test(l.msg))).toEqual([]);
  });
});
