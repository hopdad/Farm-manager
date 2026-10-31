/**
 * Replay mode on the board for the machines builder's jobs (docs/contracts-1f.md §B.6, §B.8):
 * with CONNECTOR_AEMP=replay and CONNECTOR_SAMSARA=replay (no stand-in at all), the doc-derived
 * fixtures put L1 and SP2 on the board, time-shifted to now: L1 as a last-known fix from the
 * kubota page (JSON, a bare Fleet), SP2 live from the equipment feed (its Samsara AEMP snapshot,
 * dated at the same anchor-shifted instant, doesn't replace the fresh live fix). CNH has no
 * replay mode (config refuses it).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFleetAempJob } from '../../jobs/fleet-aemp';
import { createFleetEquipmentJob } from '../../jobs/fleet-equipment';
import type { FleetConfig } from '../../jobs/fleet-shared';
import { buildDemoFarm } from '../../sim/farm/build';
import { setupTestDb } from '../../test/db';
import { seedSimFarm, testJobContext } from '../testkit';

const t = setupTestDb(import.meta.url);
const farm = buildDemoFarm();
const unit = (u: string) => farm.machines.find((m) => m.unitNo === u)?.id as string;

const wall = Date.parse('2026-11-30T15:00:30.000Z');
const now = () => new Date(wall);
const cfg: FleetConfig = {
  VENDOR_SIM_URL: 'http://127.0.0.1:9',
  PUBLIC_URL: 'http://localhost:3116',
  TOKEN_ENC_KEY: 'ef'.repeat(32),
  CONNECTOR_DEERE: 'off',
  CONNECTOR_SAMSARA: 'replay',
  CONNECTOR_MOTIVE: 'off',
  CONNECTOR_AEMP: 'replay',
  FLEET_STALE_SECONDS: 60,
  FLEET_STALE_SECONDS_DEERE: 900,
  FLEET_STALE_SECONDS_LAST_KNOWN: 10_800,
};
const ctx = (name: string) => testJobContext(t(), { name, now });

const state = async (u: string) =>
  (
    await t().pool.query(
      'select position_vendor, position_kind, ts from farm.machine_state where machine_id = $1',
      [unit(u)],
    )
  ).rows[0] as { position_vendor: string; position_kind: string; ts: Date } | undefined;

beforeAll(async () => {
  await seedSimFarm(t().adminDb, farm);
});
afterAll(() => {});

describe('fleet.equipment and fleet.aemp in replay', () => {
  test('SP2 live from the equipment fixtures, time-shifted to the moment of the call', async () => {
    const r = await createFleetEquipmentJob({ config: () => cfg })(ctx('fleet.equipment'));
    expect(r.items).toBeGreaterThan(0);
    expect(await state('SP2')).toMatchObject({ position_vendor: 'samsara', position_kind: 'live' });
    expect((await state('SP2'))?.ts.toISOString()).toBe('2026-11-30T15:00:30.000Z');
    const m = await t().pool.query('select engine_hours from farm.machines where id = $1', [
      unit('SP2'),
    ]);
    expect(Number(m.rows[0].engine_hours)).toBeGreaterThan(2400);
  });

  test('L1 last-known from the kubota fixture; SP2 keeps its live fix', async () => {
    const r = await createFleetAempJob({ config: () => cfg })(ctx('fleet.aemp'));
    expect(r.items).toBeGreaterThan(0);
    expect(await state('L1')).toMatchObject({
      position_vendor: 'aemp_kubota',
      position_kind: 'last_known',
    });
    expect((await state('L1'))?.ts.toISOString()).toBe('2026-11-30T15:00:00.000Z');
    expect(await state('SP2')).toMatchObject({ position_vendor: 'samsara', position_kind: 'live' });
  });
});
