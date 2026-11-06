/**
 * The job form's options against a real database (GET /api/v1/job-options): active products only,
 * customers of either kind (orgs first, a person's org as the hint), active fields with a current
 * boundary and their farm's customer, the crop years of D23.
 */
import { describe, expect, test } from 'vitest';
import { setupTestDb } from '../../test/db';
import { ADRIAN_QUARTER_SECTION, insertField } from '../../test/fixtures';
import { jobOptionsResponseSchema } from '../../ui/work/contract';
import { jobOptions } from './job-options';
import { createProduct, setProductActive } from './products';

const t = setupTestDb(import.meta.url);

async function party(
  name: string,
  kind: 'org' | 'person',
  roles: string[],
  orgId: string | null = null,
) {
  const r = await t().pool.query<{ id: string }>(
    `insert into farm.parties (kind, display_name, roles, org_id) values ($1, $2, $3, $4) returning id`,
    [kind, name, roles, orgId],
  );
  return r.rows[0]?.id as string;
}

describe('jobOptions', () => {
  test('what the form picks from', async () => {
    const corn = await createProduct(t().pool, {
      kind: 'seed',
      name: 'Corn 108',
      epaRegNo: null,
      restrictedUse: false,
      unit: 'kseed',
    });
    const atr = await createProduct(t().pool, {
      kind: 'chemical',
      name: 'Atrazine',
      epaRegNo: '100-497',
      restrictedUse: true,
      unit: 'gal',
    });
    const gone = await createProduct(t().pool, {
      kind: 'chemical',
      name: 'Gone',
      epaRegNo: null,
      restrictedUse: false,
      unit: 'gal',
    });
    await setProductActive(t().pool, gone.id, false);

    const juniper = await party('Juniper Hill Farms LLC', 'org', ['customer']);
    const gail = await party('Gail Pressler', 'person', ['customer'], juniper);
    const halvorsen = await party('Halvorsen Bros. Farms', 'org', ['customer']);
    await party('Ivan Abernath', 'person', ['landlord']);

    const own = await insertField(t().db, { name: 'Home 160', geom: ADRIAN_QUARTER_SECTION });
    const custom = await insertField(t().db, { name: 'Corwin 80', geom: ADRIAN_QUARTER_SECTION });
    await t().pool.query('update farm.farms set client_party_id = $2 where id = $1', [
      custom.farmId,
      halvorsen,
    ]);
    const noBoundary = await insertField(t().db, { name: 'Unmapped 40' });
    const inactive = await insertField(t().db, { name: 'Sold 20', geom: ADRIAN_QUARTER_SECTION });
    await t().pool.query('update farm.fields set active = false where id = $1', [inactive.fieldId]);

    const o = await jobOptions(t().pool, new Date('2026-11-06T15:00:00Z'));
    expect(jobOptionsResponseSchema.safeParse(o).success).toBe(true);
    expect(o.products.map((p) => p.id)).toEqual([corn.id, atr.id]);
    expect(o.products[1]).toEqual({
      id: atr.id,
      kind: 'chemical',
      name: 'Atrazine',
      unit: 'gal',
      epaRegNo: '100-497',
      restrictedUse: true,
      active: true,
    });
    expect(o.customers).toEqual([
      { id: halvorsen, name: 'Halvorsen Bros. Farms', kind: 'org', orgName: null },
      { id: juniper, name: 'Juniper Hill Farms LLC', kind: 'org', orgName: null },
      { id: gail, name: 'Gail Pressler', kind: 'person', orgName: 'Juniper Hill Farms LLC' },
    ]);
    const ids = o.fields.map((f) => f.id);
    expect(ids).toEqual([custom.fieldId, own.fieldId]);
    expect(ids).not.toContain(noBoundary.fieldId);
    expect(o.fields[0]).toMatchObject({
      name: 'Corwin 80',
      farmName: 'Home farm',
      customerId: halvorsen,
    });
    expect(o.fields[0]?.acres).toBeCloseTo(160, 0);
    expect(o.fields[1]?.customerId).toBeNull();
    expect(o.cropYears).toEqual([2026, 2027]);
    expect(o.currentCropYear).toBe(2026);
    // Spring: last season and this one.
    expect((await jobOptions(t().pool, new Date('2027-03-01T15:00:00Z'))).cropYears).toEqual([
      2026, 2027,
    ]);
  });
});
