/**
 * The job board's read side against a real database (src/db/queries/work-jobs-view.ts;
 * docs/contracts-2a.md §4.5, §5.3): double-booking per assignment on overlapping windows of
 * open jobs only (planned_for over the job's window, null never overlaps, adjacent windows
 * don't, closed jobs on neither side), `alsoOn`, the machine's "Deere" badge, the flags; the
 * field panel's open-jobs count (src/db/queries/fields.ts, assigned to jobs-api) and its index;
 * deleteParty's job-board links (src/db/queries/parties.ts, assigned); and the demo seed's
 * board: it parses, SP2 is free, and the done-when's drags make one "SP2 · Dale" row.
 */
import { describe, expect, test, vi } from 'vitest';
import { seedDemo } from '../../../tools/seed/demo';
import { seedDemoWork } from '../../../tools/seed/work';
import {
  handleAssignJob,
  handleBoardSnapshot,
  handleSetJobField,
} from '../../app/api/v1/jobs/handler';
import { jsonRequest } from '../../app/api/v1/jobs/test-requests';
import { demoId } from '../../domain/ids';
import { seedDemoPeople } from '../../platform/auth/demo';
import { makeSession, runWithSession } from '../../platform/auth/testing';
import type { Role, Session } from '../../platform/auth/types';
import { setupTestDb } from '../../test/db';
import { type BoardSnapshot, boardSnapshotSchema, type JobResponse } from '../../ui/work/contract';
import { FIELD_DETAIL_SQL, fieldDetail } from './fields';
import { deleteParty } from './parties';
import {
  insertTestAssignment,
  insertTestCustomer,
  insertTestField,
  insertTestJob,
  insertTestMachine,
  insertTestPerson,
  insertTestProduct,
} from './work-jobs-testkit';
import { jobView, jobViews } from './work-jobs-view';

vi.mock('../../platform/usage/record', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../platform/usage/record')>();
  return { ...real, recordUsage: vi.fn(async () => {}) };
});

const t = setupTestDb(import.meta.url);

/** Run `fn` as a person of `role` (null: signed out); any session field can be overridden. */
function as<T>(
  role: Role | null,
  fn: () => Promise<T>,
  overrides: Partial<Session> = {},
): Promise<T> {
  return runWithSession(role === null ? null : makeSession({ role, ...overrides }), fn);
}
const NOW = new Date('2026-11-06T14:30:00Z');
const day = (h1: number, h2: number) => ({
  from: `2026-11-06T${String(h1).padStart(2, '0')}:00:00.000Z`,
  to: `2026-11-06T${String(h2).padStart(2, '0')}:00:00.000Z`,
});

async function views(...ids: string[]) {
  const v = await jobViews(t().pool, ids);
  return Object.fromEntries(v.map((j) => [j.id, j]));
}

describe('double-booked (contracts-2a §4.5)', () => {
  test('the same machine on two open jobs with overlapping windows: flagged on both, alsoOn names the other', async () => {
    const pool = t().pool;
    const m = await insertTestMachine(pool, { unitNo: 'DB1' });
    const a = await insertTestJob(pool, { title: 'Job A', window: day(13, 17) });
    const b = await insertTestJob(pool, { kind: 'haul', title: null, window: day(16, 20) });
    await insertTestAssignment(pool, a, { machineId: m });
    await insertTestAssignment(pool, b, { machineId: m });
    const v = await views(a, b);
    expect(v[a]?.flags).toEqual(['no_field', 'double_booked']);
    expect(v[b]?.flags).toEqual(['no_field', 'double_booked']);
    expect(v[a]?.assignments[0]?.alsoOn).toEqual([{ jobId: b, summary: 'Haul' }]);
    expect(v[b]?.assignments[0]?.alsoOn).toEqual([{ jobId: a, summary: 'Job A' }]);
  });

  test('the same person: flagged too; a machine and a person both shared name the other job once', async () => {
    const pool = t().pool;
    const m = await insertTestMachine(pool);
    const p = await insertTestPerson(pool, 'Booked Twice');
    const a = await insertTestJob(pool, { window: day(8, 12) });
    const b = await insertTestJob(pool, { title: 'B', window: day(10, 11) });
    await insertTestAssignment(pool, a, { machineId: m, partyId: p.partyId });
    await insertTestAssignment(pool, b, { machineId: m, partyId: p.partyId });
    const c = await insertTestJob(pool, { title: 'C', window: day(9, 10) });
    await insertTestAssignment(pool, c, { partyId: p.partyId });
    const v = await views(a, b, c);
    expect(v[a]?.assignments[0]?.alsoOn.map((x) => x.summary)).toEqual(['C', 'B']);
    expect(v[c]?.flags).toContain('double_booked');
  });

  test('never: adjacent windows, a null window, a closed job on either side', async () => {
    const pool = t().pool;
    const m = await insertTestMachine(pool);
    const morning = await insertTestJob(pool, { window: day(8, 12) });
    const afternoon = await insertTestJob(pool, { window: day(12, 16) });
    const noWindow = await insertTestJob(pool, { window: null });
    const cancelled = await insertTestJob(pool, { status: 'cancelled', window: day(9, 10) });
    const done = await insertTestJob(pool, { status: 'done', window: day(9, 10) });
    for (const j of [morning, afternoon, noWindow, cancelled, done]) {
      await insertTestAssignment(pool, j, { machineId: m });
    }
    const v = await views(morning, afternoon, noWindow, cancelled, done);
    for (const j of Object.values(v)) {
      expect(j.flags, j.status).not.toContain('double_booked');
      expect(j.assignments[0]?.alsoOn).toEqual([]);
    }
  });

  test("an assignment's planned_for wins over the job's window", async () => {
    const pool = t().pool;
    const m = await insertTestMachine(pool);
    const a = await insertTestJob(pool, { window: day(8, 18) });
    const b = await insertTestJob(pool, { window: day(8, 18) });
    await insertTestAssignment(pool, a, { machineId: m, plannedFor: day(8, 10) });
    await insertTestAssignment(pool, b, { machineId: m, plannedFor: day(10, 12) });
    expect((await views(a))[a]?.flags).not.toContain('double_booked');
    const c = await insertTestJob(pool, { window: null });
    await insertTestAssignment(pool, c, { machineId: m, plannedFor: day(9, 11) });
    const v = await views(a, b, c);
    expect(v[a]?.flags).toContain('double_booked');
    expect(v[c]?.assignments[0]?.alsoOn.map((x) => x.jobId).sort()).toEqual([a, b].sort());
    expect(v[c]?.assignments[0]?.plannedFor).toEqual(day(9, 11));
  });
});

describe('the rest of the view', () => {
  test('the "Deere" badge: a Deere machine or one with a Deere machine ref', async () => {
    const pool = t().pool;
    const deere = await insertTestMachine(pool, { source: 'deere' });
    const linked = await insertTestMachine(pool);
    await t().admin.query(
      `insert into ingest.external_refs (source, kind, external_id, source_org, entity_id)
       values ('deere', 'machine', 'eq-1', 'org-1', $1)`,
      [linked],
    );
    const samsara = await insertTestMachine(pool);
    const j = await insertTestJob(pool);
    for (const m of [deere, linked, samsara]) await insertTestAssignment(pool, j, { machineId: m });
    const v = await jobView(pool, j);
    const badge = new Map(v?.assignments.map((a) => [a.machine?.id, a.machine?.workPlanCapable]));
    expect([badge.get(deere), badge.get(linked), badge.get(samsara)]).toEqual([true, true, false]);
  });

  test('restricted use from a product; an unknown id is no view', async () => {
    const pool = t().pool;
    const j = await insertTestJob(pool);
    await pool.query('insert into farm.job_products (job_id, product_id) values ($1, $2)', [
      j,
      await insertTestProduct(pool, { restrictedUse: true }),
    ]);
    expect((await jobView(pool, j))?.flags).toEqual(['no_field', 'restricted_use']);
    expect(await jobView(pool, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe("the field panel's open-jobs count (assigned to jobs-api)", () => {
  test('counts the open statuses only', async () => {
    const pool = t().pool;
    const f = await insertTestField(t().db, { lng: -83.3, lat: 42.4 });
    expect((await fieldDetail(pool, f.fieldId))?.openJobs).toEqual({ count: 0 });
    for (const status of ['requested', 'planned', 'assigned', 'pushed', 'in_progress'] as const) {
      await insertTestJob(pool, { fieldId: f.fieldId, status });
    }
    for (const status of ['done', 'invoiced', 'cancelled'] as const) {
      await insertTestJob(pool, { fieldId: f.fieldId, status });
    }
    await insertTestJob(pool, { status: 'planned' });
    expect((await fieldDetail(pool, f.fieldId))?.openJobs).toEqual({ count: 5 });
  });

  test('the count reads farm.jobs through jobs_field_id_idx (no sequential scan)', async () => {
    const pool = t().pool;
    const f = await insertTestField(t().db, { lng: -83.31, lat: 42.4 });
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local enable_seqscan = off');
      const r = await c.query<{ 'QUERY PLAN': unknown }>(
        `explain (format json) ${FIELD_DETAIL_SQL}`,
        [f.fieldId, NOW.toISOString()],
      );
      const text = JSON.stringify(r.rows[0]?.['QUERY PLAN']);
      expect(text).toContain('jobs_field_id_idx');
      expect(text).not.toMatch(/"Node Type":"Seq Scan","[^}]*"Relation Name":"jobs"/);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});

describe("deleteParty explains the job board's links (assigned to jobs-api)", () => {
  test('customer of jobs, asked for jobs, on jobs, agreements, request links; deletable once gone', async () => {
    const pool = t().pool;
    const actor = { appUserId: null, displayName: 'Test' } as never;
    const customer = await insertTestCustomer(pool, 'Linked Customer');
    const jobs = [
      await insertTestJob(pool, { customerPartyId: customer }),
      await insertTestJob(pool, { customerPartyId: customer }),
      await insertTestJob(pool, { customerPartyId: customer }),
    ];
    await pool.query('update farm.jobs set requested_by_party_id = $2 where id = $1', [
      jobs[0],
      customer,
    ]);
    await pool.query(
      `insert into farm.data_rights_agreements (party_id, signed_on) values ($1, '2026-10-01')`,
      [customer],
    );
    await pool.query(
      `insert into farm.job_request_links (party_id, token_hash) values ($1::uuid, 'h-' || $1::text), ($1::uuid, 'h2-' || $1::text)`,
      [customer],
    );
    await expect(deleteParty(pool, customer, actor)).rejects.toThrow(
      'still linked: customer of 3 jobs, asked for 1 job, 1 data-rights agreement, 2 job request links. Unlink those first.',
    );

    const crew = await insertTestPerson(pool, 'Linked Crew');
    for (const j of jobs.slice(0, 2))
      await insertTestAssignment(pool, j as string, { partyId: crew.partyId });
    await expect(deleteParty(pool, crew.partyId, actor)).rejects.toThrow(
      'still linked: on 2 jobs on the job board. Unlink those first.',
    );

    await pool.query('delete from farm.jobs where id = any($1::uuid[])', [jobs]);
    await pool.query('delete from farm.data_rights_agreements where party_id = $1', [customer]);
    await pool.query('delete from farm.job_request_links where party_id = $1', [customer]);
    await deleteParty(pool, customer, actor);
    await deleteParty(pool, crew.partyId, actor);
    const left = await pool.query('select 1 from farm.parties where id = any($1::uuid[])', [
      [customer, crew.partyId],
    ]);
    expect(left.rowCount).toBe(0);
  });
});

describe('the demo seed on the board', () => {
  test('parses; ten jobs; SP2 is free; the done-when drags make one "SP2 · Dale" row', async () => {
    const pool = t().pool;
    await pool.query('delete from farm.jobs');
    await seedDemo(pool, { seed: 1 });
    await seedDemoPeople(pool, 'jobs-api-view-test-secret-0123456789abcdef');
    await seedDemoWork(pool, { now: NOW });
    const res = await as('viewer', () =>
      handleBoardSnapshot(jsonRequest('GET', '/api/v1/jobs'), pool, NOW),
    );
    const snap = boardSnapshotSchema.parse(await res.json()) as BoardSnapshot;
    const all = snap.lanes.flatMap((l) => l.jobs);
    expect(all).toHaveLength(10);
    expect(snap.lanes.map((l) => l.jobs.length)).toEqual([4, 3, 2, 1]);
    const sp2 = demoId('sprayer-2');
    expect(all.some((j) => j.assignments.some((a) => a.machine?.id === sp2))).toBe(false);

    // The done-when on the demo's requested spray job: a Juniper field, then SP2, then Dale.
    const request = demoId('job-spray-juniper-request');
    const juniper = await pool.query<{ id: string }>(
      `select f.id::text as id from farm.fields f join farm.farms fa on fa.id = f.farm_id
        where fa.source_id = 'farm-juniper-hill' order by f.source_id limit 1`,
    );
    const field = juniper.rows[0]?.id as string;
    const step = async (fn: () => Promise<Response>) =>
      ((await (await as('manager', fn)).json()) as JobResponse).job;
    const placed = await step(() =>
      handleSetJobField(
        jsonRequest('PUT', '/x', { version: 1, fieldId: field }),
        request,
        pool,
        NOW,
      ),
    );
    expect(placed).toMatchObject({ status: 'requested', field: { id: field } });
    const withSp2 = await step(() =>
      handleAssignJob(
        jsonRequest('POST', '/x', { version: 2, machineId: sp2 }),
        request,
        pool,
        NOW,
      ),
    );
    expect(withSp2.status).toBe('assigned');
    const dale = await step(() =>
      handleAssignJob(
        jsonRequest('POST', '/x', { version: 3, partyId: demoId('crew-dale') }),
        request,
        pool,
        NOW,
      ),
    );
    expect(dale.assignments).toHaveLength(1);
    expect(dale.assignments[0]).toMatchObject({
      role: 'operator',
      machine: { unitNo: 'SP2', kind: 'sprayer', workPlanCapable: false },
      person: { name: 'Dale Mercer', initials: 'DM' },
    });
    // Dale's harvest is today, this request tomorrow: no double booking.
    expect(dale.flags).toEqual([]);
    // Luis is on C2 from today into tomorrow: overlapping, flagged on both cards.
    const luis = await step(() =>
      handleAssignJob(
        jsonRequest('POST', '/x', { version: 4, partyId: demoId('crew-luis') }),
        request,
        pool,
        NOW,
      ),
    );
    expect(luis.flags).toEqual(['double_booked']);
    const c2 = await jobView(pool, demoId('job-harvest-c2'));
    expect(c2?.flags).toContain('double_booked');

    // The open-jobs count of each demo field the seed put jobs on (for the field panel).
    const counts = await pool.query<{ name: string; n: number }>(
      `select f.name, count(*)::int as n from farm.jobs j join farm.fields f on f.id = j.field_id
        where j.status in ('requested', 'planned', 'assigned', 'pushed', 'in_progress')
        group by f.name order by f.name`,
    );
    for (const row of counts.rows) {
      const id = (
        await pool.query<{ id: string }>('select id::text as id from farm.fields where name = $1', [
          row.name,
        ])
      ).rows[0]?.id as string;
      expect((await fieldDetail(pool, id))?.openJobs.count, row.name).toBe(row.n);
    }
    console.log(
      `[work-jobs-view] demo open jobs per field: ${counts.rows.map((r) => `${r.name} ${r.n}`).join(', ')}`,
    );
  });
});
