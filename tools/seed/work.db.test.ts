/**
 * The job board's demo rows (./work.ts; docs/contracts-2a.md §9): products, ten jobs across the
 * four lanes with the done-when's pieces, the Halvorsen agreement; idempotent; jobs written once.
 */
import { describe, expect, test } from 'vitest';
import { currentCropYear } from '../../src/domain/crops';
import { demoId } from '../../src/domain/ids';
import {
  autoJobStatus,
  BUSINESS_LINES,
  type JobStatus,
  PERMITTED_USES,
} from '../../src/domain/work-jobs';
import { seedDemoPeople } from '../../src/platform/auth/demo';
import { setupTestDb } from '../../src/test/db';
import { seedDemo } from './demo';
import { DEMO_JOBS, DEMO_PRODUCTS, seedDemoWork } from './work';

const t = setupTestDb(import.meta.url);
const SECRET = 'work-seed-test-secret-0123456789abcdef';
// A fixed clock: Friday Nov 6, 2026, 9:30 AM in Detroit (EST since Nov 1).
const NOW = new Date('2026-11-06T14:30:00Z');

describe('seedDemoWork', () => {
  test('without the demo farm nothing is written', async () => {
    const r = await seedDemoWork(t().pool, { now: NOW });
    expect(r.jobs).toEqual({ inserted: 0, existing: 0, skipped: DEMO_JOBS.length });
    const n = await t().pool.query('select 1 from farm.products');
    expect(n.rowCount).toBe(0);
  });

  test('products, ten jobs in all four lanes, the done-when pieces and the Halvorsen agreement', async () => {
    const { pool } = t();
    await seedDemo(pool, { seed: 1 });
    await seedDemoPeople(pool, SECRET);
    const r = await seedDemoWork(pool, { now: NOW });
    expect(r.products.inserted).toBe(DEMO_PRODUCTS.length);
    expect(r.jobs).toEqual({ inserted: 10, existing: 0, skipped: 0 });
    expect(r.agreements.inserted).toBe(1);

    const lanes = await pool.query<{ business_line: string; n: number }>(
      `select business_line, count(*)::int as n from farm.jobs where source = 'demo'
        group by business_line order by business_line`,
    );
    expect(lanes.rows.map((x) => x.business_line).sort()).toEqual([...BUSINESS_LINES].sort());
    const statuses = await pool.query<{ status: string }>(
      `select distinct status from farm.jobs where source = 'demo'`,
    );
    expect(statuses.rows.length).toBeGreaterThanOrEqual(5);

    // An unassigned spray job on a field (planned acres = the boundary's), and a requested one
    // with no field yet; SP2 is on no job.
    const unassigned = await pool.query(
      `select j.planned_acres, b.acres from farm.jobs j
         join farm.current_boundaries b on b.field_id = j.field_id
        where j.source = 'demo' and j.kind = 'spray' and j.status = 'planned'
          and not exists (select 1 from farm.job_assignments a where a.job_id = j.id)`,
    );
    expect(unassigned.rowCount).toBe(1);
    expect(Number(unassigned.rows[0]?.planned_acres)).toBeCloseTo(
      Number(unassigned.rows[0]?.acres),
    );
    const requested = await pool.query(
      `select request_channel, requester_name, requested_by_party_id::text as by
         from farm.jobs where source = 'demo' and status = 'requested' and field_id is null`,
    );
    expect(requested.rows).toEqual([
      {
        request_channel: 'phone',
        requester_name: 'Gail Pressler',
        by: demoId('customer-juniper-hill-gail'),
      },
    ]);
    const sp2 = await pool.query(
      `select 1 from farm.job_assignments a join farm.machines m on m.id = a.machine_id
        where m.unit_no = 'SP2'`,
    );
    expect(sp2.rowCount).toBe(0);
    // SP1 run by Tom is one row, role operator.
    const sp1 = await pool.query(
      `select a.role, p.display_name from farm.job_assignments a
         join farm.machines m on m.id = a.machine_id join farm.parties p on p.id = a.party_id
        where m.unit_no = 'SP1'`,
    );
    expect(sp1.rows).toEqual([{ role: 'operator', display_name: 'Tom Rietzel' }]);

    const agreement = await pool.query(
      `select p.display_name, a.permitted_uses, a.revoked_on from farm.data_rights_agreements a
         join farm.parties p on p.id = a.party_id`,
    );
    expect(agreement.rows).toEqual([
      {
        display_name: 'Halvorsen Bros. Farms',
        permitted_uses: [...PERMITTED_USES],
        revoked_on: null,
      },
    ]);
    const restricted = await pool.query(
      `select name from farm.products where restricted_use and epa_reg_no like 'DEMO-%'`,
    );
    expect(restricted.rowCount).toBe(1);

    // Each customer org links to its party (the gate's loader and customerOrgParty read it):
    // Halvorsen's own org and Juniper Hill's, which has no farm ref of its own.
    expect(r.orgLinks).toEqual({ inserted: 2, existing: 0 });
    const links = await pool.query(
      `select r.external_id as org, p.display_name from ingest.external_refs r
         join farm.parties p on p.id = r.entity_id
        where r.source = 'deere' and r.kind = 'party' and r.source_org = r.external_id
        order by 1`,
    );
    expect(links.rows).toEqual([
      { org: 'org-customer-1', display_name: 'Halvorsen Bros. Farms' },
      { org: 'org-customer-2', display_name: 'Juniper Hill Farms LLC' },
    ]);

    // The demo agrees with the status machine: every job with a field and an assignment that
    // could be assigned is (autoJobStatus), and crop years follow the field (D23 rule).
    const jobs = await pool.query<{
      source_id: string;
      status: JobStatus;
      has_field: boolean;
      n: number;
      crop_year: number | null;
    }>(
      `select j.source_id, j.status, j.field_id is not null as has_field, j.crop_year,
              (select count(*)::int from farm.job_assignments a where a.job_id = j.id) as n
         from farm.jobs j where j.source = 'demo'`,
    );
    for (const j of jobs.rows) {
      expect(autoJobStatus(j.status, { hasField: j.has_field, assignmentCount: j.n })).toBe(
        j.status,
      );
      expect(j.crop_year).toBe(j.has_field ? currentCropYear(NOW) : null);
    }
  });

  test('a second run writes nothing, and what the board changed stays', async () => {
    const { pool } = t();
    await pool.query(
      `update farm.jobs set status = 'cancelled', version = version + 1 where source_id = 'job-haul-s2'`,
    );
    await pool.query(`update farm.products set active = false where source_id = 'product-diesel'`);
    const r = await seedDemoWork(pool, { now: new Date(NOW.getTime() + 86_400_000) });
    expect(r.products).toEqual({ inserted: 0, updated: 0, unchanged: DEMO_PRODUCTS.length });
    expect(r.jobs).toEqual({ inserted: 0, existing: 10, skipped: 0 });
    expect(r.agreements).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    expect(r.orgLinks).toEqual({ inserted: 0, existing: 2 });
    const kept = await pool.query(
      `select j.status, j.version, p.active from farm.jobs j, farm.products p
        where j.source_id = 'job-haul-s2' and p.source_id = 'product-diesel'`,
    );
    expect(kept.rows).toEqual([{ status: 'cancelled', version: 2, active: false }]);
  });
});
