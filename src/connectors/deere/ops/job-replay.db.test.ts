/**
 * deere.ops in replay mode (CONNECTOR_DEERE=replay: the live client on the committed fixtures,
 * no OAuth) against a database seeded with the demo farm: the 2026 fixture operations land on
 * the seeded fields (1a: harvest and planting on four fields, through the per-operation
 * measurementTypes call; deere-ops's 30 fixture: plantings with embedded measurements, a
 * burndown, a coverage refused with 400), with the machines and operators matched, and a run
 * within the same replay minute lands nothing new.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDeereOpsJob, type DeereOpsConfig } from '../../../jobs/deere-ops';
import { setupTestDb } from '../../../test/db';
import { listenAppEvents, seedSimFarm, testJobContext } from '../../testkit';
import { fixtureFarm } from '../fixtures/build';
import { OPS_FIXTURE_FIELDS } from './fixtures';

const t = setupTestDb(import.meta.url);
const farm = fixtureFarm();
const WALL = Date.parse('2026-10-31T13:00:10.000Z');
const now = () => new Date(WALL);
const cfg: DeereOpsConfig = {
  VENDOR_SIM_URL: 'http://127.0.0.1:1',
  PUBLIC_URL: 'http://localhost:3112',
  TOKEN_ENC_KEY: 'cd'.repeat(32),
  CONNECTOR_DEERE: 'replay',
};
const run = () =>
  createDeereOpsJob({ config: () => cfg })(testJobContext(t(), { name: 'deere.ops', now }));
let listener: Awaited<ReturnType<typeof listenAppEvents>>;

beforeAll(async () => {
  await seedSimFarm(t().adminDb, farm);
  listener = await listenAppEvents(t().appUrl);
}, 120_000);
afterAll(() => listener?.close());

describe('deere.ops (replay)', () => {
  test('the 2026 fixture operations land on the seeded fields', async () => {
    const total = 4 + 4 + OPS_FIXTURE_FIELDS + 1;
    expect(await run()).toEqual({ items: total });
    const r = await t().pool.query(
      `select o.kind, o.field_id::text as field_id, o.crop, o.crop_year, o.status,
              o.geom is not null as has_geom, o.area_reported_ac::float8 as reported,
              o.measurements, o.products, o.operator_name,
              (select array_agg(m.unit_no order by m.unit_no) from farm.machines m
                where m.id = any(o.machine_ids)) as units
         from farm.operations o order by o.started_at`,
    );
    expect(r.rows).toHaveLength(total);
    const fieldIds = new Set(farm.fields.map((f) => f.id));
    expect(r.rows.every((x) => fieldIds.has(x.field_id))).toBe(true);
    expect(r.rows.every((x) => x.crop_year === 2026)).toBe(true);
    const harvests = r.rows.filter((x) => x.kind === 'harvest');
    expect(harvests).toHaveLength(4);
    for (const h of harvests) {
      expect(h.crop).toBe('corn');
      expect(h.status).toBe('provisional'); // the harvest day replays as yesterday
      expect(h.measurements.yieldBuAc).toBeGreaterThan(100);
      expect(h.units?.[0]).toMatch(/^C[12]$/);
      expect(h.has_geom).toBe(true);
    }
    const plantings = r.rows.filter((x) => x.kind === 'seeding');
    expect(plantings).toHaveLength(4 + OPS_FIXTURE_FIELDS);
    expect(plantings.every((x) => x.status === 'final' && x.units?.[0] === 'P1')).toBe(true);
    expect(r.rows.filter((x) => !x.has_geom)).toHaveLength(1);
    const spray = r.rows.find((x) => x.kind === 'application');
    expect(spray).toMatchObject({ operator_name: 'Luis Ortega', units: ['SP1'] });
    expect(spray?.products[0]).toMatchObject({ name: 'Tank Mix', rate: 15, rateUnit: 'gal1ac-1' });
    await listener.settle();
    expect(listener.of('admin', 'sync.status').length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test('a run within the same replay minute lands nothing new', async () => {
    expect(await run()).toEqual({ items: 0 });
  }, 60_000);
});
