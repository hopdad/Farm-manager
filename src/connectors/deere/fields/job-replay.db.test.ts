/**
 * deere.fields end to end in REPLAY mode (docs/contracts-1f.md §8, §11.1): CONNECTOR_DEERE=replay,
 * no stand-in, no network, no OAuth, on the demo farm as the seed writes it. The doc-derived
 * fixtures (1a plus deere-data's 20-29) land the same way sim does: the demo fields matched, the
 * Deere-only field created in its farm, Deere boundaries as current versions, flags as pins,
 * engine hours on the six Deere machines. Re-runs within the day replay the same bytes (nothing
 * written); the next day's run only appends the new engine-hours report and re-stamps the flags.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { deterministicId } from '../../../domain/ids';
import { createDeereFieldsJob, type DeereFieldsConfig } from '../../../jobs/deere-fields';
import { buildDemoFarm } from '../../../sim/farm/build';
import { simFlags } from '../../../sim/farm/flags';
import { simDeereOnlyField } from '../../../sim/vendors/deere/fields-world';
import { setupTestDb } from '../../../test/db';
import { seedSimFarm, testJobContext } from '../../testkit';

const t = setupTestDb(import.meta.url);
const farm = buildDemoFarm(1);
const only = simDeereOnlyField(farm);

let wall = Date.parse('2026-11-30T15:00:00.000Z');
const now = () => new Date(wall);
const cfg: DeereFieldsConfig = {
  VENDOR_SIM_URL: 'http://127.0.0.1:9', // nothing listens: replay must not need the stand-in
  PUBLIC_URL: 'http://localhost:3111',
  TOKEN_ENC_KEY: 'ab'.repeat(32),
  CONNECTOR_DEERE: 'replay',
};
const run = () =>
  createDeereFieldsJob({ config: () => cfg, http: { timeoutMs: 2_000 } })(
    testJobContext(t(), { name: 'deere.fields', now }),
  );
const n = async (sql: string) => (await t().pool.query<{ n: number }>(sql)).rows[0]?.n ?? 0;

beforeAll(async () => {
  await seedSimFarm(t().adminDb, farm);
});

describe('deere.fields in replay mode', () => {
  test('the fixtures land like sim: fields, boundaries, pins, engine hours', async () => {
    const result = await run();
    expect(result.items).toBeGreaterThan(farm.fields.length);
    expect(await n('select count(*)::int as n from farm.fields')).toBe(farm.fields.length + 1);
    const created = await t().pool.query(
      `select f.id::text, f.tenure, fa.deere_farm_id from farm.fields f join farm.farms fa on fa.id = f.farm_id
        where f.source = 'deere'`,
    );
    expect(created.rows).toEqual([
      {
        id: deterministicId('deere', only?.deereFieldId as string),
        tenure: 'unknown',
        deere_farm_id: only?.farm.id,
      },
    ]);
    expect(
      await n(
        `select count(*)::int as n from farm.field_boundaries where upper_inf(valid) and source = 'deere'`,
      ),
    ).toBe(farm.fields.length + 1);
    expect(await n(`select count(*)::int as n from farm.pins`)).toBe(simFlags(farm, 1).length);
    expect(await n(`select count(*)::int as n from farm.pins where resolved_at is not null`)).toBe(
      1,
    );
    expect(
      await n(`select count(*)::int as n from farm.machine_hours where source = 'deere'`),
    ).toBe(6);
  });

  test('a re-run the same day writes nothing', async () => {
    wall += 10 * 60_000;
    expect(await run()).toEqual({ items: 0 });
  });

  test('the next day: one new engine-hours report per machine, no new boundary version', async () => {
    const versions = await n(`select count(*)::int as n from farm.field_boundaries`);
    wall += 86_400_000;
    const result = await run();
    expect(result.items).toBeGreaterThan(0);
    expect(await n(`select count(*)::int as n from farm.field_boundaries`)).toBe(versions);
    expect(
      await n(`select count(*)::int as n from farm.machine_hours where source = 'deere'`),
    ).toBe(12);
    expect(await n(`select count(*)::int as n from farm.pins`)).toBe(simFlags(farm, 1).length);
  });
});
