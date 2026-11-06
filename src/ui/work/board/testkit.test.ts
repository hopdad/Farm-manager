/**
 * The board's API stand-in (./testkit.ts) against the contract: the answers parse with the
 * contract's schemas, and the drag semantics, the status machine, the 409 and reorder's rules
 * are the ones docs/contracts-2a.md §4-§5 give (so the e2e specs that run on it before the merge
 * test the board against the real behaviour).
 */
import { describe, expect, test } from 'vitest';
import type { JobsUpdatedPayload } from '../../../platform/realtime/types';
import {
  boardSnapshotSchema,
  type CrewPerson,
  crewResponseSchema,
  JOB_CONFLICT_MESSAGE,
  type JobMachineView,
  type JobView,
  jobConflictResponseSchema,
  jobResponseSchema,
} from '../contract';
import {
  createMapWorld,
  MockJobsApi,
  type MockViewer,
  makeJobView,
  mockRouteHandler,
} from './testkit';

const NOW = new Date('2026-11-06T17:00:00Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FIELD = { id: id(1), name: 'Corwin 80', farmName: 'Halvorsen', boundaryAcres: 78.4 };
const CUSTOMER = { id: id(2), name: 'Halvorsen Bros. Farms' };
const SP2: JobMachineView = {
  id: id(10),
  unitNo: 'SP2',
  kind: 'sprayer',
  status: 'active',
  workPlanCapable: false,
};
const SP1: JobMachineView = { ...SP2, id: id(11), unitNo: 'SP1', workPlanCapable: true };
const DOWN: JobMachineView = { ...SP2, id: id(12), unitNo: 'C3', status: 'down' };
const RETIRED: JobMachineView = { ...SP2, id: id(13), unitNo: 'OLD', status: 'retired' };
const crew = (n: number, name: string): CrewPerson => ({
  partyId: id(20 + n),
  appUserId: null,
  name,
  initials: '',
  appRole: 'operator',
  active: true,
});
const DALE = crew(1, 'Dale Mercer');
const LUIS = crew(2, 'Luis Ortega');
const MANAGER: MockViewer = { role: 'manager', partyId: null };

function world() {
  return createMapWorld({
    fields: [{ ...FIELD, customer: CUSTOMER }],
    machines: [SP2, SP1, DOWN, RETIRED],
    crew: [DALE, LUIS],
    fieldAt: ({ lng }) => (lng > -84 ? FIELD.id : null),
  });
}

function setup(jobs: Partial<JobView>[] = [{}]) {
  const api = new MockJobsApi(world(), { now: () => NOW });
  jobs.forEach((p, i) => {
    api.put(makeJobView({ id: id(100 + i), kind: 'spray', status: 'requested', ...p }, NOW));
  });
  const changes: JobsUpdatedPayload[] = [];
  api.onChange((p) => changes.push(p));
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    viewer: MockViewer | null = MANAGER,
  ) =>
    api.handle({
      method,
      url: `http://localhost${path}`,
      body: body === undefined ? null : JSON.stringify(body),
      viewer,
    });
  const job = (n = 0) => api.jobs.get(id(100 + n)) as JobView;
  return { api, call, job, changes };
}

describe('reads', () => {
  test('the snapshot: four lanes, open jobs in order, the day’s done ones; viewer hints', async () => {
    const { call } = setup([
      { priority: 3, sortKey: 20 },
      { priority: 1, sortKey: 90 },
      { businessLine: 'grain', status: 'done', statusChangedAt: '2026-11-06T15:00:00Z' },
      { businessLine: 'grain', status: 'done', statusChangedAt: '2026-11-04T15:00:00Z' },
      { status: 'cancelled' },
    ]);
    const res = await call('GET', '/api/v1/jobs', undefined, { role: 'driver', partyId: id(9) });
    expect(res.status).toBe(200);
    const s = boardSnapshotSchema.parse(res.body);
    expect(s.lanes.map((l) => l.businessLine)).toEqual(['spraying', 'grain', 'trucking', 'store']);
    expect(s.lanes[0]?.jobs.map((j) => j.id)).toEqual([id(101), id(100)]);
    expect(s.lanes[1]?.jobs.map((j) => j.id)).toEqual([id(102)]);
    expect(s.viewer).toEqual({ role: 'driver', partyId: id(9), canPlan: false });
    expect(s.lanes[0]?.jobs[1]?.flags).toEqual(['no_field']);
  });

  test('crew, one job, and refusals', async () => {
    const { call } = setup();
    const crewRes = await call('GET', '/api/v1/crew');
    expect(crewResponseSchema.parse(crewRes.body).people.map((p) => p.name)).toEqual([
      'Dale Mercer',
      'Luis Ortega',
    ]);
    expect(
      jobResponseSchema.parse((await call('GET', `/api/v1/jobs/${id(100)}`)).body).job.id,
    ).toBe(id(100));
    expect((await call('GET', `/api/v1/jobs/${id(999)}`)).status).toBe(404);
    expect((await call('GET', '/api/v1/jobs', undefined, null)).status).toBe(401);
    // The job form's routes are job-forms' (the foundation's stubs answer 501).
    expect((await call('POST', '/api/v1/jobs', { kind: 'spray' })).status).toBe(501);
    expect((await call('PATCH', `/api/v1/jobs/${id(100)}`, { version: 1 })).status).toBe(501);
  });
});

describe('the done-when’s drags (decision 2a-4)', () => {
  test('a requested job: onto a field, then SP2, then an operator = one row "SP2 · Dale"', async () => {
    const { call, job, changes } = setup();
    let r = await call('PUT', `/api/v1/jobs/${id(100)}/field`, { version: 1, fieldId: FIELD.id });
    expect(r.status).toBe(200);
    expect(job()).toMatchObject({
      version: 2,
      status: 'requested',
      field: { id: FIELD.id, name: 'Corwin 80', boundaryAcres: 78.4 },
      customer: CUSTOMER,
      plannedAcres: 78.4,
      cropYear: 2026,
      flags: [],
    });
    expect(changes.at(-1)).toEqual({
      jobIds: [id(100)],
      fieldIds: [FIELD.id],
      machineIds: [],
      partyIds: [],
    });
    r = await call('POST', `/api/v1/jobs/${id(100)}/assignments`, {
      version: 2,
      machineId: SP2.id,
    });
    expect(r.status).toBe(200);
    // A field and an assignment: requested -> assigned (accepted by assigning it).
    expect(job()).toMatchObject({ version: 3, status: 'assigned' });
    r = await call('POST', `/api/v1/jobs/${id(100)}/assignments`, {
      version: 3,
      partyId: DALE.partyId,
    });
    expect(r.status).toBe(200);
    expect(job().assignments).toHaveLength(1);
    expect(job().assignments[0]).toMatchObject({
      role: 'operator',
      machine: { unitNo: 'SP2' },
      person: { name: 'Dale Mercer' },
    });
    expect(changes.at(-1)?.partyIds).toEqual([DALE.partyId]);
  });

  test('person then machine is one row; a second machine a second row; already on = no-op', async () => {
    const { call, job, changes } = setup();
    await call('POST', `/api/v1/jobs/${id(100)}/assignments`, {
      version: 1,
      partyId: LUIS.partyId,
    });
    await call('POST', `/api/v1/jobs/${id(100)}/assignments`, { version: 2, machineId: SP1.id });
    expect(job().assignments).toHaveLength(1);
    await call('POST', `/api/v1/jobs/${id(100)}/assignments`, { version: 3, machineId: SP2.id });
    expect(job().assignments.map((a) => a.machine?.unitNo)).toEqual(['SP1', 'SP2']);
    const before = changes.length;
    const again = await call('POST', `/api/v1/jobs/${id(100)}/assignments`, {
      version: 4,
      machineId: SP2.id,
    });
    expect(again.status).toBe(200);
    expect(job().version).toBe(4);
    expect(changes).toHaveLength(before);
  });

  test('by the drop point; not on a field; a down machine is flagged, a retired one refused', async () => {
    const { call, job } = setup();
    const miss = await call('PUT', `/api/v1/jobs/${id(100)}/field`, {
      version: 1,
      at: { lng: -85, lat: 41.7 },
    });
    expect(miss).toEqual({
      status: 422,
      body: { error: 'not on a field', reason: 'not_on_field' },
    });
    const hit = await call('PUT', `/api/v1/jobs/${id(100)}/field`, {
      version: 1,
      at: { lng: -83.7, lat: 41.7 },
    });
    expect(hit.status).toBe(200);
    expect(job().field?.id).toBe(FIELD.id);
    await call('POST', `/api/v1/jobs/${id(100)}/assignments`, { version: 2, machineId: DOWN.id });
    expect(job().flags).toContain('machine_down');
    const retired = await call('POST', `/api/v1/jobs/${id(100)}/assignments`, {
      version: 3,
      machineId: RETIRED.id,
    });
    expect(retired).toMatchObject({ status: 422, body: { reason: 'machine_retired' } });
    expect(
      (await call('POST', `/api/v1/jobs/${id(100)}/assignments`, { version: 3, machineId: id(77) }))
        .status,
    ).toBe(404);
  });

  test('unassign a part or the row; the last one off sends an assigned job back to planned', async () => {
    const { call, job } = setup([{ field: FIELD }]);
    await call('POST', `/api/v1/jobs/${id(100)}/assignments`, { version: 1, machineId: SP2.id });
    await call('POST', `/api/v1/jobs/${id(100)}/assignments`, {
      version: 2,
      partyId: DALE.partyId,
    });
    const aid = job().assignments[0]?.id as string;
    let r = await call(
      'DELETE',
      `/api/v1/jobs/${id(100)}/assignments/${aid}?version=3&part=machine`,
    );
    expect(r.status).toBe(200);
    expect(job().assignments[0]).toMatchObject({ machine: null, person: { name: 'Dale Mercer' } });
    expect(job().status).toBe('assigned');
    r = await call('DELETE', `/api/v1/jobs/${id(100)}/assignments/${aid}?version=4`);
    expect(r.status).toBe(200);
    expect(job()).toMatchObject({ assignments: [], status: 'planned' });
    expect(
      (await call('DELETE', `/api/v1/jobs/${id(100)}/assignments/${aid}?version=5`)).status,
    ).toBe(404);
  });

  test('double-booked: the same machine on overlapping open windows, flagged on both', async () => {
    const window = { from: '2026-11-06T13:00:00Z', to: '2026-11-06T22:00:00Z' };
    const { call, api } = setup([{ window }, { window }, {}]);
    await call('POST', `/api/v1/jobs/${id(100)}/assignments`, { version: 1, machineId: SP2.id });
    await call('POST', `/api/v1/jobs/${id(101)}/assignments`, { version: 1, machineId: SP2.id });
    // A null window never overlaps.
    await call('POST', `/api/v1/jobs/${id(102)}/assignments`, { version: 1, machineId: SP2.id });
    const a = api.jobs.get(id(100)) as JobView;
    const b = api.jobs.get(id(101)) as JobView;
    const c = api.jobs.get(id(102)) as JobView;
    expect(a.flags).toContain('double_booked');
    expect(b.flags).toContain('double_booked');
    expect(c.flags).not.toContain('double_booked');
    expect(a.assignments[0]?.alsoOn.map((x) => x.jobId)).toEqual([id(101)]);
  });
});

describe('versions, roles and the status machine', () => {
  test('a stale version is a 409 with the current job; nothing changes', async () => {
    const { call, api, job } = setup();
    api.touch(id(100), { title: 'Changed elsewhere' });
    const r = await call('PUT', `/api/v1/jobs/${id(100)}/field`, { version: 1, fieldId: FIELD.id });
    expect(r.status).toBe(409);
    const body = jobConflictResponseSchema.parse(r.body);
    expect(body.error).toBe(JOB_CONFLICT_MESSAGE);
    expect(body.job).toMatchObject({ version: 2, title: 'Changed elsewhere', field: null });
    expect(job().field).toBeNull();
  });

  test('writes need a manager; status needs a driver on their own job', async () => {
    const { call } = setup([{ field: FIELD, status: 'assigned' }]);
    const viewer = { role: 'viewer' as const, partyId: null };
    expect(
      (await call('PUT', `/api/v1/jobs/${id(100)}/field`, { version: 1, fieldId: null }, viewer))
        .status,
    ).toBe(403);
    const driver = { role: 'driver' as const, partyId: DALE.partyId };
    expect(
      (
        await call(
          'POST',
          `/api/v1/jobs/${id(100)}/assignments`,
          { version: 1, partyId: DALE.partyId },
          driver,
        )
      ).status,
    ).toBe(403);
    // Not their job yet.
    expect(
      (
        await call(
          'POST',
          `/api/v1/jobs/${id(100)}/status`,
          { version: 1, status: 'in_progress' },
          driver,
        )
      ).status,
    ).toBe(403);
    await call('POST', `/api/v1/jobs/${id(100)}/assignments`, {
      version: 1,
      partyId: DALE.partyId,
    });
    const ok = await call(
      'POST',
      `/api/v1/jobs/${id(100)}/status`,
      { version: 2, status: 'in_progress' },
      driver,
    );
    expect(ok.status).toBe(200);
    expect(
      (
        await call(
          'POST',
          `/api/v1/jobs/${id(100)}/status`,
          { version: 3, status: 'in_progress' },
          driver,
        )
      ).body,
    ).toMatchObject({ reason: 'same' });
    expect(
      (await call('POST', `/api/v1/jobs/${id(100)}/status`, { version: 3, status: 'cancelled' }))
        .body,
    ).toMatchObject({ reason: 'not_allowed' });
  });

  test('cancel: open jobs only, with the reason; the job leaves the board', async () => {
    const { call, job, api } = setup([{}, { status: 'done' }]);
    const r = await call('POST', `/api/v1/jobs/${id(100)}/cancel`, { version: 1, reason: 'rain' });
    expect(r.status).toBe(200);
    expect(job()).toMatchObject({ status: 'cancelled', cancelledReason: 'rain' });
    expect(api.snapshot(MANAGER).lanes[0]?.jobs.map((j) => j.id)).not.toContain(id(100));
    expect(
      (await call('POST', `/api/v1/jobs/${id(101)}/cancel`, { version: 1 })).body,
    ).toMatchObject({
      reason: 'closed',
    });
  });

  test('reorder: the whole lane, stale or missing = 409, another lane = 422', async () => {
    const { call, api } = setup([
      { sortKey: 10 },
      { sortKey: 20 },
      { sortKey: 30, businessLine: 'grain' },
    ]);
    const lane = [
      { id: id(101), version: 1 },
      { id: id(100), version: 1 },
    ];
    const r = await call('POST', '/api/v1/jobs/reorder', { businessLine: 'spraying', jobs: lane });
    expect(r.status).toBe(200);
    expect(boardSnapshotSchema.parse(r.body).lanes[0]?.jobs.map((j) => j.id)).toEqual([
      id(101),
      id(100),
    ]);
    expect(api.jobs.get(id(101))).toMatchObject({ sortKey: 10, version: 2 });
    expect(api.jobs.get(id(100))).toMatchObject({ sortKey: 20, version: 2 });
    const stale = await call('POST', '/api/v1/jobs/reorder', {
      businessLine: 'spraying',
      jobs: lane,
    });
    expect(stale.status).toBe(409);
    const missing = await call('POST', '/api/v1/jobs/reorder', {
      businessLine: 'spraying',
      jobs: [{ id: id(101), version: 2 }],
    });
    expect(missing).toMatchObject({ status: 409, body: { job: { id: id(100) } } });
    const other = await call('POST', '/api/v1/jobs/reorder', {
      businessLine: 'spraying',
      jobs: [{ id: id(102), version: 1 }],
    });
    expect(other).toMatchObject({ status: 422, body: { reason: 'not_in_lane' } });
  });

  test('bad bodies are 400s', async () => {
    const { call } = setup();
    expect((await call('PUT', `/api/v1/jobs/${id(100)}/field`, { fieldId: FIELD.id })).status).toBe(
      400,
    );
    expect((await call('POST', `/api/v1/jobs/${id(100)}/assignments`, { version: 1 })).status).toBe(
      400,
    );
    expect((await call('DELETE', `/api/v1/jobs/${id(100)}/assignments/${id(5)}`)).status).toBe(400);
  });
});

test('the Playwright handler answers JSON with no-store', async () => {
  const { api } = setup();
  const fulfilled: { status: number; headers: Record<string, string>; body: string }[] = [];
  await mockRouteHandler(
    api,
    MANAGER,
  )({
    request: () => ({
      method: () => 'GET',
      url: () => 'http://x/api/v1/crew',
      postData: () => null,
    }),
    fulfill: async (r) => {
      fulfilled.push(r);
    },
  });
  expect(fulfilled[0]?.status).toBe(200);
  expect(fulfilled[0]?.headers['cache-control']).toBe('no-store');
  expect(JSON.parse(fulfilled[0]?.body ?? '{}').people).toHaveLength(2);
});
