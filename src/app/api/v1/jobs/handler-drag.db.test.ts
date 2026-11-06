/**
 * Drag semantics through the routes (decision 2a-4, docs/contracts-2a.md §4.5, §4.6, §11.1): a
 * card dropped on a field by id or by the drop point (inside a current boundary, outside = 422,
 * the hidden-layer path), the customer from the field's farm, planned acres from the boundary
 * or by hand, the crop year from the field's growing year; machine then person and person then
 * machine filling one row, a second machine making a second row, already on = no-op, a down
 * machine taken and flagged, a retired one refused; the × by row and by side; and the automatic
 * moves both ways.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  insertTestAssignment,
  insertTestCustomer,
  insertTestField,
  insertTestJob,
  insertTestMachine,
  insertTestPerson,
} from '@/db/queries/work-jobs-testkit';
import { currentCropYear } from '@/domain/crops';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import type { Role, Session } from '@/platform/auth/types';
import { recordUsage } from '@/platform/usage/record';
import { setupTestDb } from '@/test/db';
import { squareMultiPolygon } from '@/test/fixtures';
import type { JobResponse, JobView } from '@/ui/work/contract';
import {
  handleAssignJob,
  handleCreateJob,
  handleGetJob,
  handleSetJobField,
  handleUnassignJob,
  handleUpdateJob,
} from './handler';
import { bodyOf, jsonRequest } from './test-requests';

vi.mock('@/platform/usage/record', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/platform/usage/record')>();
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
const UNKNOWN = '00000000-0000-4000-8000-000000000000';
// Friday Nov 6, 2026 in Detroit: the synced seasons are [2026, 2027] (D23).
const NOW = new Date('2026-11-06T14:30:00Z');

beforeEach(() => vi.mocked(recordUsage).mockClear());

async function view(id: string): Promise<JobView> {
  const res = await as('viewer', () => handleGetJob(id, t().pool));
  return (await bodyOf<JobResponse>(res)).job;
}

async function answer(
  res: Promise<Response>,
): Promise<{ status: number; job: JobView; body: unknown }> {
  const r = await res;
  const body = (await r.json()) as { job: JobView };
  return { status: r.status, job: body.job, body };
}

const putField = (id: string, body: unknown) =>
  answer(as('manager', () => handleSetJobField(jsonRequest('PUT', '/x', body), id, t().pool, NOW)));
const assign = (id: string, body: unknown) =>
  answer(as('manager', () => handleAssignJob(jsonRequest('POST', '/x', body), id, t().pool, NOW)));
const unassign = (id: string, aid: string, q: string) =>
  answer(
    as('manager', () =>
      handleUnassignJob(jsonRequest('DELETE', `/x?${q}`), id, aid, t().pool, NOW),
    ),
  );
const patch = (id: string, body: unknown) =>
  answer(as('manager', () => handleUpdateJob(jsonRequest('PATCH', '/x', body), id, t().pool, NOW)));

let nextLng = -85.0;
/** A field (400 m square, about 39.5 ac) in its own spot, optionally a customer's. */
async function field(opts: { customer?: string | null; name?: string } = {}) {
  nextLng += 0.01;
  const f = await insertTestField(t().db, { lng: nextLng, lat: 42.2, name: opts.name });
  if (opts.customer) {
    await t().pool.query('update farm.farms set client_party_id = $2 where id = $1', [
      f.farmId,
      opts.customer,
    ]);
  }
  const acres = await t().pool.query<{ acres: number }>(
    'select acres::float8 as acres from farm.current_boundaries where field_id = $1',
    [f.fieldId],
  );
  return {
    ...f,
    acres: acres.rows[0]?.acres as number,
    center: { lng: nextLng + 0.0024, lat: 42.2018 },
  };
}

describe('a card dropped on a field', () => {
  test('by id: the field, the customer from its farm, its boundary acres, its growing year', async () => {
    const halvorsen = await insertTestCustomer(t().pool, 'Halvorsen Drag');
    const f = await field({ customer: halvorsen, name: 'Halvorsen Drag 40' });
    await t().pool.query(
      `insert into farm.operations (kind, field_id, crop_year, started_at, source)
       values ('seeding', $1, 2027, now(), 'test')`,
      [f.fieldId],
    );
    const id = await insertTestJob(t().pool, { status: 'requested' });
    const r = await putField(id, { version: 1, fieldId: f.fieldId });
    expect(r.status).toBe(200);
    expect(r.job).toMatchObject({
      version: 2,
      status: 'requested',
      field: { id: f.fieldId, name: 'Halvorsen Drag 40', farmName: 'Home farm' },
      customer: { id: halvorsen, name: 'Halvorsen Drag' },
      plannedAcresByHand: false,
      cropYear: 2027,
      flags: [],
    });
    expect(r.job.plannedAcres).toBeCloseTo(f.acres, 2);
    expect(r.job.field?.boundaryAcres).toBeCloseTo(f.acres, 2);
    expect(r.job.summary).toBe(`Spray · Halvorsen Drag 40 · ${Math.round(f.acres)} ac`);
  });

  test('no operations in the synced seasons: the calendar year; a customer already set stays', async () => {
    const mine = await insertTestCustomer(t().pool, 'Already Mine');
    const other = await insertTestCustomer(t().pool, 'Field Owner');
    const f = await field({ customer: other });
    await t().pool.query(
      `insert into farm.operations (kind, field_id, crop_year, started_at, source)
       values ('harvest', $1, 2024, now(), 'test')`,
      [f.fieldId],
    );
    const id = await insertTestJob(t().pool, { customerPartyId: mine });
    const r = await putField(id, { version: 1, fieldId: f.fieldId });
    expect(r.job.cropYear).toBe(currentCropYear(NOW));
    expect(r.job.customer?.id).toBe(mine);
  });

  test('by the drop point (fields layer hidden or under z8): the field whose CURRENT boundary holds it', async () => {
    const f = await field({ name: 'Point 40' });
    const id = await insertTestJob(t().pool);
    const r = await putField(id, { version: 1, at: f.center });
    expect(r.status).toBe(200);
    expect(r.job.field?.id).toBe(f.fieldId);

    // Outside every boundary: 422 not_on_field, nothing changes.
    const other = await insertTestJob(t().pool);
    const miss = await as('manager', () =>
      handleSetJobField(
        jsonRequest('PUT', '/x', { version: 1, at: { lng: -89.9, lat: 30.1 } }),
        other,
        t().pool,
        NOW,
      ),
    );
    expect(miss.status).toBe(422);
    expect(await miss.json()).toEqual({ error: 'not on a field', reason: 'not_on_field' });
    expect((await view(other)).version).toBe(1);
  });

  test('by point: an old boundary version and an inactive field are not "on a field"', async () => {
    const pool = t().pool;
    const f = await field();
    // Replace the boundary with one 2 km east: the old spot is no longer the field's.
    const moved = squareMultiPolygon(nextLng + 0.03, 42.2, 400);
    await pool.query(
      `update farm.field_boundaries set valid = tstzrange(lower(valid), now(), '[)') where field_id = $1`,
      [f.fieldId],
    );
    await pool.query(
      `insert into farm.field_boundaries (field_id, geom, source, valid)
       values ($1, extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($2), 4326), 'import',
               tstzrange(now(), null, '[)'))`,
      [f.fieldId, JSON.stringify(moved)],
    );
    nextLng += 0.04;
    const id = await insertTestJob(pool);
    const old = await putField(id, { version: 1, at: f.center });
    expect(old.status).toBe(422);
    const now = await putField(id, {
      version: 1,
      at: { lng: f.center.lng + 0.03, lat: f.center.lat },
    });
    expect(now.job.field?.id).toBe(f.fieldId);

    const g = await field();
    await pool.query('update farm.fields set active = false where id = $1', [g.fieldId]);
    const j = await insertTestJob(pool);
    expect((await putField(j, { version: 1, at: g.center })).status).toBe(422);
    // By id an inactive field is still taken (the manager picked it).
    expect((await putField(j, { version: 1, fieldId: g.fieldId })).status).toBe(200);
  });

  test('the field it already has: nothing written; an unknown field: 404; null clears it', async () => {
    const f = await field();
    const id = await insertTestJob(t().pool, { fieldId: f.fieldId });
    const same = await putField(id, { version: 1, fieldId: f.fieldId.toUpperCase() });
    expect(same).toMatchObject({ status: 200, job: { version: 1 } });
    const unknown = await putField(id, { version: 1, fieldId: UNKNOWN });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: 'field not found' });
    const cleared = await putField(id, { version: 1, fieldId: null });
    expect(cleared.job).toMatchObject({ version: 2, field: null, flags: ['no_field'] });
  });
});

describe('planned acres (decision 2a-5)', () => {
  test('typed by hand they stay through a field change; null hands them back to the boundary', async () => {
    const a = await field();
    const b = await field();
    const created = await answer(
      as('manager', () =>
        handleCreateJob(
          jsonRequest('POST', '/api/v1/jobs', {
            kind: 'spray',
            fieldId: a.fieldId,
            plannedAcres: 30,
          }),
          t().pool,
          NOW,
        ),
      ),
    );
    expect(created.job).toMatchObject({
      plannedAcres: 30,
      plannedAcresByHand: true,
      flags: ['acres_differ'],
    });
    const moved = await putField(created.job.id, { version: 1, fieldId: b.fieldId });
    expect(moved.job).toMatchObject({ plannedAcres: 30, plannedAcresByHand: true });
    const back = await patch(created.job.id, { version: 2, plannedAcres: null });
    expect(back.job.plannedAcresByHand).toBe(false);
    expect(back.job.plannedAcres).toBeCloseTo(b.acres, 2);
    expect(back.job.flags).toEqual([]);
    // Not by hand: a field change re-snapshots; a PATCH fieldId follows the same rules.
    const again = await patch(created.job.id, { version: 3, fieldId: a.fieldId });
    expect(again.job.plannedAcres).toBeCloseTo(a.acres, 2);
    const typed = await patch(created.job.id, { version: 4, plannedAcres: 41.25 });
    expect(typed.job).toMatchObject({ plannedAcres: 41.25, plannedAcresByHand: true });
  });

  test("later boundary changes don't move a job's acres; the card flags the difference over 1 %", async () => {
    const pool = t().pool;
    const f = await field();
    const id = await insertTestJob(pool);
    const set = await putField(id, { version: 1, fieldId: f.fieldId });
    expect(set.job.flags).toEqual([]);
    // A new boundary 10 % larger (Deere re-versions boundaries).
    const bigger = squareMultiPolygon(nextLng, 42.2, 400 * Math.sqrt(1.1));
    await pool.query(
      `update farm.field_boundaries set valid = tstzrange(lower(valid), now(), '[)') where field_id = $1`,
      [f.fieldId],
    );
    await pool.query(
      `insert into farm.field_boundaries (field_id, geom, source, valid)
       values ($1, extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($2), 4326), 'import',
               tstzrange(now(), null, '[)'))`,
      [f.fieldId, JSON.stringify(bigger)],
    );
    const v = await view(id);
    expect(v.plannedAcres).toBeCloseTo(f.acres, 2);
    expect(v.field?.boundaryAcres).toBeCloseTo(f.acres * 1.1, 0);
    expect(v.flags).toEqual(['acres_differ']);
  });
});

describe('a card dropped on a machine or a person chip', () => {
  test('machine then person: one row, SP2 run by the person (operator)', async () => {
    const pool = t().pool;
    const sp2 = await insertTestMachine(pool, { unitNo: 'SP2' });
    const dale = await insertTestPerson(pool, 'Dale Drag', { appRole: 'operator' });
    const id = await insertTestJob(pool);
    const m = await assign(id, { version: 1, machineId: sp2 });
    expect(m.job.assignments).toEqual([
      expect.objectContaining({
        role: 'operator',
        machine: expect.objectContaining({ unitNo: 'SP2' }),
        person: null,
      }),
    ]);
    const p = await assign(id, { version: 2, partyId: dale.partyId });
    expect(p.job.version).toBe(3);
    expect(p.job.assignments).toHaveLength(1);
    expect(p.job.assignments[0]).toMatchObject({
      role: 'operator',
      machine: { id: sp2, unitNo: 'SP2' },
      person: { partyId: dale.partyId, name: 'Dale Drag', initials: 'DD' },
    });
  });

  test('person then machine: one row too; a second machine makes a second row', async () => {
    const pool = t().pool;
    const luis = await insertTestPerson(pool, 'Luis Drag');
    const c1 = await insertTestMachine(pool, { unitNo: 'C1D', kind: 'combine' });
    const gc1 = await insertTestMachine(pool, { unitNo: 'GC1D', kind: 'grain_cart' });
    const id = await insertTestJob(pool, { kind: 'harvest', businessLine: 'grain' });
    const p = await assign(id, { version: 1, partyId: luis.partyId });
    expect(p.job.assignments[0]).toMatchObject({ role: 'crew', machine: null });
    const m = await assign(id, { version: 2, machineId: c1 });
    expect(m.job.assignments).toHaveLength(1);
    expect(m.job.assignments[0]).toMatchObject({
      role: 'operator',
      machine: { id: c1 },
      person: { partyId: luis.partyId },
    });
    const second = await assign(id, { version: 3, machineId: gc1 });
    expect(second.job.assignments.map((a) => [a.machine?.unitNo, a.person?.name ?? null])).toEqual([
      ['C1D', 'Luis Drag'],
      ['GC1D', null],
    ]);
    // A person then fills the machine-only row.
    const jake = await insertTestPerson(pool, 'Jake Drag');
    const filled = await assign(id, { version: 4, partyId: jake.partyId });
    expect(filled.job.assignments.map((a) => [a.machine?.unitNo, a.person?.name ?? null])).toEqual([
      ['C1D', 'Luis Drag'],
      ['GC1D', 'Jake Drag'],
    ]);
    // Both at once: one new row.
    const s1 = await insertTestMachine(pool, { unitNo: 'S1D', kind: 'semi' });
    const ben = await insertTestPerson(pool, 'Ben Drag');
    const both = await assign(id, { version: 5, machineId: s1, partyId: ben.partyId });
    expect(both.job.assignments.map((a) => [a.machine?.unitNo, a.person?.name ?? null])).toEqual([
      ['C1D', 'Luis Drag'],
      ['GC1D', 'Jake Drag'],
      ['S1D', 'Ben Drag'],
    ]);
  });

  test('already on the job: nothing changes, 200 with the same version', async () => {
    const pool = t().pool;
    const machine = await insertTestMachine(pool);
    const person = await insertTestPerson(pool, 'Already On');
    const id = await insertTestJob(pool);
    await insertTestAssignment(pool, id, { machineId: machine, partyId: person.partyId });
    for (const body of [
      { machineId: machine },
      { partyId: person.partyId },
      { machineId: machine.toUpperCase(), partyId: person.partyId },
    ]) {
      const r = await assign(id, { version: 1, ...body });
      expect(r.status).toBe(200);
      expect(r.job.version).toBe(1);
      expect(r.job.assignments).toHaveLength(1);
    }
  });

  test('a down machine is taken and flagged (card and chip); a retired one is 422; unknown ones 404', async () => {
    const pool = t().pool;
    const down = await insertTestMachine(pool, { unitNo: 'DWN', status: 'down' });
    const retired = await insertTestMachine(pool, { unitNo: 'RET', status: 'retired' });
    const f = await field();
    const id = await insertTestJob(pool, { fieldId: f.fieldId });
    const r = await assign(id, { version: 1, machineId: down });
    expect(r.status).toBe(200);
    expect(r.job.assignments[0]?.machine?.status).toBe('down');
    expect(r.job.flags).toEqual(['machine_down']);
    const ret = await assign(id, { version: 2, machineId: retired });
    expect(ret.status).toBe(422);
    expect(ret.body).toEqual({ error: 'RET is retired', reason: 'machine_retired' });
    const noMachine = await assign(id, { version: 2, machineId: UNKNOWN });
    expect(noMachine).toMatchObject({ status: 404, body: { error: 'machine not found' } });
    const noPerson = await assign(id, { version: 2, partyId: UNKNOWN });
    expect(noPerson).toMatchObject({ status: 404, body: { error: 'person not found' } });
    const org = await insertTestCustomer(pool, 'Not A Person');
    expect((await assign(id, { version: 2, partyId: org })).status).toBe(404);
    expect((await view(id)).version).toBe(2);
  });
});

describe('the × on an assignment chip', () => {
  test('the whole row, or one side of it; a row left with neither is deleted', async () => {
    const pool = t().pool;
    const f = await field();
    const m1 = await insertTestMachine(pool, { unitNo: 'X1' });
    const m2 = await insertTestMachine(pool, { unitNo: 'X2' });
    const p1 = await insertTestPerson(pool, 'Pat One');
    const p2 = await insertTestPerson(pool, 'Pat Two');
    const id = await insertTestJob(pool, { fieldId: f.fieldId, status: 'assigned' });
    const both = await insertTestAssignment(pool, id, { machineId: m1, partyId: p1.partyId });
    const both2 = await insertTestAssignment(pool, id, { machineId: m2, partyId: p2.partyId });

    const noMachine = await unassign(id, both, 'version=1&part=machine');
    expect(noMachine.job.assignments[0]).toMatchObject({
      id: both,
      role: 'crew',
      machine: null,
      person: { partyId: p1.partyId },
    });
    const noPerson = await unassign(id, both2, 'version=2&part=person');
    expect(noPerson.job.assignments[1]).toMatchObject({
      id: both2,
      role: 'operator',
      machine: { id: m2 },
      person: null,
    });
    // Clearing a side the row hasn't got changes nothing.
    const same = await unassign(id, both2, 'version=3&part=person');
    expect(same.job.version).toBe(3);
    // The last side goes: the row goes.
    const gone = await unassign(id, both, 'version=3&part=person');
    expect(gone.job.assignments.map((a) => a.id)).toEqual([both2]);
    expect(gone.job.status).toBe('assigned');
    // The whole row: the last one, so the job goes back to planned.
    const last = await unassign(id, both2, 'version=4');
    expect(last.job).toMatchObject({
      version: 5,
      assignments: [],
      status: 'planned',
      statusChangedAt: NOW.toISOString(),
    });
  });

  test('an assignment of another job is 404 and changes nothing', async () => {
    const pool = t().pool;
    const a = await insertTestJob(pool);
    const b = await insertTestJob(pool);
    const aid = await insertTestAssignment(pool, b, { machineId: await insertTestMachine(pool) });
    const r = await unassign(a, aid, 'version=1');
    expect(r).toMatchObject({ status: 404, body: { error: 'assignment not found' } });
    expect((await view(b)).assignments).toHaveLength(1);
  });
});

describe('the automatic moves (decision 2a-3)', () => {
  test('a requested job with a field becomes assigned by its first assignment (accepting it)', async () => {
    const pool = t().pool;
    const f = await field();
    const id = await insertTestJob(pool, {
      status: 'requested',
      statusChangedAt: new Date('2026-11-01T12:00:00Z'),
    });
    const placed = await putField(id, { version: 1, fieldId: f.fieldId });
    expect(placed.job.status).toBe('requested');
    expect(placed.job.statusChangedAt).toBe('2026-11-01T12:00:00.000Z');
    const r = await assign(id, { version: 2, machineId: await insertTestMachine(pool) });
    expect(r.job).toMatchObject({
      status: 'assigned',
      statusChangedAt: NOW.toISOString(),
      flags: [],
    });
  });

  test('assigned first, then the field: assigned on the drop onto the field', async () => {
    const pool = t().pool;
    const f = await field();
    const id = await insertTestJob(pool);
    const r = await assign(id, {
      version: 1,
      partyId: (await insertTestPerson(pool, 'First Person')).partyId,
    });
    expect(r.job).toMatchObject({ status: 'planned', flags: ['no_field'] });
    const placed = await putField(id, { version: 2, at: f.center });
    expect(placed.job.status).toBe('assigned');
  });

  test("clearing an assigned job's field keeps it assigned and flags no_field (PUT, PATCH, a field delete)", async () => {
    const pool = t().pool;
    for (const how of ['put', 'patch', 'delete'] as const) {
      const f = await field();
      const id = await insertTestJob(pool, { fieldId: f.fieldId, status: 'assigned' });
      await insertTestAssignment(pool, id, { machineId: await insertTestMachine(pool) });
      if (how === 'put') await putField(id, { version: 1, fieldId: null });
      if (how === 'patch') await patch(id, { version: 1, fieldId: null });
      if (how === 'delete') {
        await t().admin.query('delete from farm.field_boundaries where field_id = $1', [f.fieldId]);
        await t().admin.query('delete from farm.fields where id = $1', [f.fieldId]);
      }
      const v = await view(id);
      expect(v, how).toMatchObject({ status: 'assigned', field: null, flags: ['no_field'] });
    }
  });

  test('an in-progress job keeps its status through any assignment change', async () => {
    const pool = t().pool;
    const f = await field();
    const id = await insertTestJob(pool, { fieldId: f.fieldId, status: 'in_progress' });
    const aid = await insertTestAssignment(pool, id, { machineId: await insertTestMachine(pool) });
    const r = await unassign(id, aid, 'version=1');
    expect(r.job.status).toBe('in_progress');
  });
});
