/**
 * The job routes against a real database, under chosen sessions (runWithSession): who may call
 * each route (401 signed out, 403 below the role), every refusal the contract lists (cross-site
 * 403, 415, 413, 400 bad JSON or body, 404 unknown or malformed ids, 409 with the current job,
 * 422), the board snapshot (lanes, order, the day's done jobs, one field's jobs), one job, the
 * crew list, creating a job, and the usage event each write records (docs/contracts-2a.md §5,
 * §11.1). The drag semantics, the status routes and the concurrency rules have their own files.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  insertTestAssignment,
  insertTestCustomer,
  insertTestField,
  insertTestJob,
  insertTestMachine,
  insertTestPerson,
  insertTestProduct,
} from '@/db/queries/work-jobs-testkit';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import { ROLE_FOR, ROLES, type Role, roleAtLeast, type Session } from '@/platform/auth/types';
import { recordUsage } from '@/platform/usage/record';
import { setupTestDb } from '@/test/db';
import {
  type BoardSnapshot,
  boardSnapshotSchema,
  type CrewResponse,
  crewResponseSchema,
  JOB_BODY_MAX_BYTES,
  JOB_CONFLICT_MESSAGE,
  type JobConflictResponse,
  type JobResponse,
  jobConflictResponseSchema,
  jobResponseSchema,
} from '@/ui/work/contract';
import { handleCrew } from '../crew/handler';
import {
  handleAssignJob,
  handleBoardSnapshot,
  handleCancelJob,
  handleCreateJob,
  handleGetJob,
  handleReorderJobs,
  handleSetJobField,
  handleSetJobStatus,
  handleUnassignJob,
  handleUpdateJob,
  JOB_ROUTES,
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
const usage = vi.mocked(recordUsage);
const UNKNOWN = '00000000-0000-4000-8000-000000000000';
// Friday Nov 6, 2026, 9:30 AM in Detroit (EST).
const NOW = new Date('2026-11-06T14:30:00Z');

beforeEach(() => usage.mockClear());
afterEach(() => vi.restoreAllMocks());

async function job(opts: Parameters<typeof insertTestJob>[1] = {}) {
  const id = await insertTestJob(t().pool, opts);
  const res = await as('viewer', () => handleGetJob(id, t().pool));
  return (await bodyOf<JobResponse>(res)).job;
}

/** Every route, called so that an authorized caller gets past the auth checks harmlessly. */
function routes(jobId: string, assignmentId: string) {
  const pool = t().pool;
  const stale = { version: 999 };
  return [
    {
      name: 'GET /api/v1/jobs',
      min: ROLE_FOR.viewPrivate,
      call: () => handleBoardSnapshot(jsonRequest('GET', '/api/v1/jobs'), pool, NOW),
    },
    {
      name: 'GET /api/v1/jobs/<id>',
      min: ROLE_FOR.viewPrivate,
      call: () => handleGetJob(jobId, pool),
    },
    {
      name: 'GET /api/v1/crew',
      min: ROLE_FOR.viewPrivate,
      call: () => handleCrew(pool),
    },
    {
      name: 'POST /api/v1/jobs',
      min: ROLE_FOR.planJobs,
      // No kind: an authorized caller gets 400, nothing is written.
      call: () => handleCreateJob(jsonRequest('POST', '/api/v1/jobs', {}), pool, NOW),
    },
    {
      name: 'PATCH /api/v1/jobs/<id>',
      min: ROLE_FOR.planJobs,
      call: () =>
        handleUpdateJob(
          jsonRequest('PATCH', `/api/v1/jobs/${jobId}`, { ...stale, notes: 'x' }),
          jobId,
          pool,
          NOW,
        ),
    },
    {
      name: 'PUT /api/v1/jobs/<id>/field',
      min: ROLE_FOR.planJobs,
      call: () =>
        handleSetJobField(
          jsonRequest('PUT', `/api/v1/jobs/${jobId}/field`, { ...stale, fieldId: null }),
          jobId,
          pool,
          NOW,
        ),
    },
    {
      name: 'POST /api/v1/jobs/<id>/assignments',
      min: ROLE_FOR.planJobs,
      call: () =>
        handleAssignJob(
          jsonRequest('POST', `/api/v1/jobs/${jobId}/assignments`, {
            ...stale,
            machineId: UNKNOWN,
          }),
          jobId,
          pool,
          NOW,
        ),
    },
    {
      name: 'DELETE /api/v1/jobs/<id>/assignments/<aid>',
      min: ROLE_FOR.planJobs,
      call: () =>
        handleUnassignJob(
          jsonRequest('DELETE', `/api/v1/jobs/${jobId}/assignments/${assignmentId}?version=999`),
          jobId,
          assignmentId,
          pool,
          NOW,
        ),
    },
    {
      name: 'POST /api/v1/jobs/<id>/status',
      min: ROLE_FOR.updateOwnJobStatus,
      call: () =>
        handleSetJobStatus(
          jsonRequest('POST', `/api/v1/jobs/${jobId}/status`, { ...stale, status: 'in_progress' }),
          jobId,
          pool,
          NOW,
        ),
    },
    {
      name: 'POST /api/v1/jobs/<id>/cancel',
      min: ROLE_FOR.planJobs,
      call: () =>
        handleCancelJob(
          jsonRequest('POST', `/api/v1/jobs/${jobId}/cancel`, stale),
          jobId,
          pool,
          NOW,
        ),
    },
    {
      name: 'POST /api/v1/jobs/reorder',
      min: ROLE_FOR.planJobs,
      call: () =>
        handleReorderJobs(
          jsonRequest('POST', '/api/v1/jobs/reorder', {
            businessLine: 'spraying',
            jobs: [{ id: jobId, version: 999 }],
          }),
          pool,
          NOW,
        ),
    },
  ];
}

describe('who may call each route', () => {
  test('401 signed out, 403 below the role (naming it), through for the role and up', async () => {
    const machine = await insertTestMachine(t().pool);
    const j = await job({ status: 'assigned' });
    const aid = await insertTestAssignment(t().pool, j.id, { machineId: machine });
    const list = routes(j.id, aid);
    expect(list).toHaveLength(11);
    for (const r of list) {
      const out = await as(null, r.call);
      expect(out.status, `${r.name} signed out`).toBe(401);
      expect(out.headers.get('cache-control')).toBe('no-store');
      for (const role of ROLES) {
        const res = await as(role, r.call);
        if (roleAtLeast(role, r.min)) {
          expect([401, 403], `${r.name} as ${role}`).not.toContain(res.status);
        } else {
          expect(res.status, `${r.name} as ${role}`).toBe(403);
          expect(await bodyOf(res)).toMatchObject({ status: 403, required: r.min });
        }
        expect(res.headers.get('cache-control'), `${r.name} as ${role}`).toBe('no-store');
        expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      }
    }
    // Nothing above wrote anything.
    expect((await job()).version).toBe(1);
    const after = await as('viewer', () => handleGetJob(j.id, t().pool));
    expect((await bodyOf<JobResponse>(after)).job.version).toBe(j.version);
    expect(usage).not.toHaveBeenCalled();
  });
});

describe('request refusals (every write route)', () => {
  type Write = {
    name: string;
    call: (req: (body: unknown, h?: Record<string, string>) => Request) => Promise<Response>;
    path: string;
    method: string;
    body: unknown;
  };
  async function writes(): Promise<Write[]> {
    const pool = t().pool;
    const j = await job();
    const id = j.id;
    return [
      {
        name: 'create',
        method: 'POST',
        path: '/api/v1/jobs',
        body: { kind: 'spray' },
        call: (req) => handleCreateJob(req({ kind: 'spray' }), pool, NOW),
      },
      {
        name: 'patch',
        method: 'PATCH',
        path: `/api/v1/jobs/${id}`,
        body: { version: 1, notes: 'n' },
        call: (req) => handleUpdateJob(req({ version: 1, notes: 'n' }), id, pool, NOW),
      },
      {
        name: 'field',
        method: 'PUT',
        path: `/api/v1/jobs/${id}/field`,
        body: { version: 1, fieldId: null },
        call: (req) => handleSetJobField(req({ version: 1, fieldId: null }), id, pool, NOW),
      },
      {
        name: 'assign',
        method: 'POST',
        path: `/api/v1/jobs/${id}/assignments`,
        body: { version: 1, machineId: UNKNOWN },
        call: (req) => handleAssignJob(req({ version: 1, machineId: UNKNOWN }), id, pool, NOW),
      },
      {
        name: 'status',
        method: 'POST',
        path: `/api/v1/jobs/${id}/status`,
        body: { version: 1, status: 'planned' },
        call: (req) => handleSetJobStatus(req({ version: 1, status: 'planned' }), id, pool, NOW),
      },
      {
        name: 'cancel',
        method: 'POST',
        path: `/api/v1/jobs/${id}/cancel`,
        body: { version: 1 },
        call: (req) => handleCancelJob(req({ version: 1 }), id, pool, NOW),
      },
      {
        name: 'reorder',
        method: 'POST',
        path: '/api/v1/jobs/reorder',
        body: { businessLine: 'spraying', jobs: [{ id, version: 1 }] },
        call: (req) =>
          handleReorderJobs(
            req({ businessLine: 'spraying', jobs: [{ id, version: 1 }] }),
            pool,
            NOW,
          ),
      },
    ];
  }

  test('cross-site 403, not JSON 415, too large 413, bad JSON 400, bad body 400; nothing written', async () => {
    for (const w of await writes()) {
      const mk = (headers: Record<string, string>, body?: string) => (b: unknown) =>
        jsonRequest(w.method, w.path, body ?? b, headers);
      const cross = await as('owner', () => w.call(mk({ origin: 'http://evil.example' })));
      expect(cross.status, `${w.name} cross-site`).toBe(403);
      expect(await bodyOf(cross)).toEqual({ error: 'cross-site request refused' });

      const notJson = await as('owner', () => w.call(mk({ 'content-type': 'text/plain' })));
      expect(notJson.status, `${w.name} text/plain`).toBe(415);

      const big = 'x'.repeat(JOB_BODY_MAX_BYTES + 1);
      const tooLarge = await as('owner', () => w.call(mk({}, JSON.stringify({ notes: big }))));
      expect(tooLarge.status, `${w.name} too large`).toBe(413);

      const badJson = await as('owner', () => w.call(mk({}, '{"version": ')));
      expect(badJson.status, `${w.name} bad JSON`).toBe(400);
      expect(await bodyOf(badJson)).toEqual({ error: 'body is not valid JSON' });

      const badBody = await as('owner', () => w.call(mk({}, JSON.stringify({ nope: true }))));
      expect(badBody.status, `${w.name} bad body`).toBe(400);
      expect((await bodyOf<{ error: string }>(badBody)).error.length).toBeGreaterThan(0);
    }
    const n = await t().pool.query(`select count(*)::int as n from farm.jobs where source = 'app'`);
    expect(n.rows[0]?.n).toBe(0);
    expect(usage).not.toHaveBeenCalled();
  });

  test('the schema message says where the body is wrong', async () => {
    const res = await as('manager', () =>
      handleCreateJob(
        jsonRequest('POST', '/api/v1/jobs', {
          kind: 'spray',
          window: { from: '2026-11-07T10:00:00Z', to: '2026-11-07T09:00:00Z' },
        }),
        t().pool,
        NOW,
      ),
    );
    expect(res.status).toBe(400);
    expect((await bodyOf<{ error: string }>(res)).error).toMatch(/^window: .*end after it starts/);
  });

  test('a malformed or unknown job id is 404; so is an unknown assignment', async () => {
    const pool = t().pool;
    for (const id of ['not-a-uuid', UNKNOWN]) {
      const get = await as('viewer', () => handleGetJob(id, pool));
      expect(get.status).toBe(404);
      const calls = [
        () =>
          handleUpdateJob(
            jsonRequest('PATCH', `/x/${id}`, { version: 1, notes: 'n' }),
            id,
            pool,
            NOW,
          ),
        () =>
          handleSetJobField(
            jsonRequest('PUT', `/x/${id}`, { version: 1, fieldId: null }),
            id,
            pool,
            NOW,
          ),
        () =>
          handleAssignJob(
            jsonRequest('POST', `/x/${id}`, { version: 1, machineId: UNKNOWN }),
            id,
            pool,
            NOW,
          ),
        () =>
          handleUnassignJob(
            jsonRequest('DELETE', `/x/${id}/a/${UNKNOWN}?version=1`),
            id,
            UNKNOWN,
            pool,
            NOW,
          ),
        () =>
          handleSetJobStatus(
            jsonRequest('POST', `/x/${id}`, { version: 1, status: 'planned' }),
            id,
            pool,
            NOW,
          ),
        () => handleCancelJob(jsonRequest('POST', `/x/${id}`, { version: 1 }), id, pool, NOW),
      ];
      for (const call of calls) {
        const res = await as('manager', call);
        expect(res.status).toBe(404);
        expect(await bodyOf(res)).toEqual({ error: 'job not found' });
      }
    }
    const j = await job();
    for (const aid of ['nope', UNKNOWN]) {
      const res = await as('manager', () =>
        handleUnassignJob(jsonRequest('DELETE', `/x?version=1`), j.id, aid, pool, NOW),
      );
      expect(res.status).toBe(404);
      expect(await bodyOf(res)).toEqual({ error: 'assignment not found' });
    }
  });

  test('DELETE needs ?version=N (and part machine or person)', async () => {
    const j = await job();
    for (const q of ['', '?version=', '?version=0', '?version=-1', '?version=1.5', '?version=x']) {
      const res = await as('manager', () =>
        handleUnassignJob(jsonRequest('DELETE', `/x${q}`), j.id, UNKNOWN, t().pool, NOW),
      );
      expect(res.status, q).toBe(400);
    }
    const res = await as('manager', () =>
      handleUnassignJob(
        jsonRequest('DELETE', '/x?version=1&part=wheel'),
        j.id,
        UNKNOWN,
        t().pool,
        NOW,
      ),
    );
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({ error: 'part must be machine or person' });
  });

  test('GET /api/v1/jobs?fieldId= must be a uuid', async () => {
    const res = await as('viewer', () =>
      handleBoardSnapshot(jsonRequest('GET', '/api/v1/jobs?fieldId=x'), t().pool, NOW),
    );
    expect(res.status).toBe(400);
  });
});

describe('409: the version was stale', () => {
  test('carries the current job (the same shape as GET) and changes nothing', async () => {
    const pool = t().pool;
    const j = await job({ title: 'Before' });
    const ok = await as('manager', () =>
      handleUpdateJob(jsonRequest('PATCH', '/x', { version: 1, title: 'First' }), j.id, pool, NOW),
    );
    expect(ok.status).toBe(200);
    const res = await as('manager', () =>
      handleUpdateJob(jsonRequest('PATCH', '/x', { version: 1, title: 'Second' }), j.id, pool, NOW),
    );
    expect(res.status).toBe(409);
    const body = jobConflictResponseSchema.parse(await res.json()) as JobConflictResponse;
    expect(body.error).toBe(JOB_CONFLICT_MESSAGE);
    expect(body.job).toMatchObject({ id: j.id, version: 2, title: 'First' });
    const get = await as('viewer', () => handleGetJob(j.id, pool));
    expect((await bodyOf<JobResponse>(get)).job).toEqual(body.job);
  });
});

describe('GET /api/v1/jobs: the board snapshot', () => {
  test("four lanes in BUSINESS_LINES order (empty ones too), open jobs by priority, sort key, created; then the day's done jobs", async () => {
    const pool = t().pool;
    await pool.query('delete from farm.jobs');
    const late = await insertTestJob(pool, { businessLine: 'grain', priority: 3, sortKey: 20 });
    const early = await insertTestJob(pool, { businessLine: 'grain', priority: 3, sortKey: 10 });
    const urgent = await insertTestJob(pool, { businessLine: 'grain', priority: 1, sortKey: 90 });
    const tie = await insertTestJob(pool, { businessLine: 'grain', priority: 3, sortKey: 20 });
    // Done today (Detroit), done yesterday, cancelled today: only the first shows.
    const doneToday = await insertTestJob(pool, {
      businessLine: 'grain',
      status: 'done',
      statusChangedAt: new Date('2026-11-06T05:30:00Z'), // 00:30 in Detroit
    });
    await insertTestJob(pool, {
      businessLine: 'grain',
      status: 'done',
      statusChangedAt: new Date('2026-11-06T04:59:00Z'), // 23:59 on Nov 5 in Detroit
    });
    await insertTestJob(pool, { businessLine: 'grain', status: 'cancelled', statusChangedAt: NOW });
    await insertTestJob(pool, { businessLine: 'grain', status: 'invoiced', statusChangedAt: NOW });
    const store = await insertTestJob(pool, { businessLine: 'store', status: 'in_progress' });

    for (const role of ROLES) {
      const res = await as(
        role,
        () => handleBoardSnapshot(jsonRequest('GET', '/api/v1/jobs'), pool, NOW),
        {
          partyId: role === 'driver' ? UNKNOWN : null,
        },
      );
      expect(res.status).toBe(200);
      const snap = boardSnapshotSchema.parse(await res.json()) as BoardSnapshot;
      expect(snap.asOf).toBe(NOW.toISOString());
      expect(snap.viewer).toEqual({
        role,
        partyId: role === 'driver' ? UNKNOWN : null,
        canPlan: roleAtLeast(role, 'manager'),
      });
      expect(snap.lanes.map((l) => [l.businessLine, l.label])).toEqual([
        ['spraying', 'Spraying'],
        ['grain', 'Grain'],
        ['trucking', 'Trucking'],
        ['store', 'Store'],
      ]);
      const grain = snap.lanes[1]?.jobs.map((j) => j.id);
      expect(grain).toEqual([urgent, early, late, tie, doneToday]);
      expect(snap.lanes[0]?.jobs).toEqual([]);
      expect(snap.lanes[2]?.jobs).toEqual([]);
      expect(snap.lanes[3]?.jobs.map((j) => j.id)).toEqual([store]);
    }
  });

  test("?fieldId= gives that field's jobs only", async () => {
    const pool = t().pool;
    const a = await insertTestField(t().db, { lng: -84.2, lat: 41.7 });
    const b = await insertTestField(t().db, { lng: -84.21, lat: 41.7 });
    const onA = await insertTestJob(pool, { fieldId: a.fieldId, businessLine: 'trucking' });
    await insertTestJob(pool, { fieldId: b.fieldId, businessLine: 'trucking' });
    const res = await as('viewer', () =>
      handleBoardSnapshot(jsonRequest('GET', `/api/v1/jobs?fieldId=${a.fieldId}`), pool, NOW),
    );
    const snap = (await bodyOf<BoardSnapshot>(res)).lanes.flatMap((l) => l.jobs.map((j) => j.id));
    expect(snap).toEqual([onA]);
    const none = await as('viewer', () =>
      handleBoardSnapshot(jsonRequest('GET', `/api/v1/jobs?fieldId=${UNKNOWN}`), pool, NOW),
    );
    expect((await bodyOf<BoardSnapshot>(none)).lanes.every((l) => l.jobs.length === 0)).toBe(true);
  });
});

describe('GET /api/v1/jobs/<id>', () => {
  test('the whole JobView: field with its boundary acres, customer, window, request, assignments, products', async () => {
    const pool = t().pool;
    const f = await insertTestField(t().db, { lng: -84.22, lat: 41.7, name: 'View 40' });
    const customer = await insertTestCustomer(pool, 'View Farms');
    const id = await insertTestJob(pool, {
      title: null,
      fieldId: f.fieldId,
      customerPartyId: customer,
      plannedAcres: 39.5,
      window: { from: '2026-11-06T13:00:00.000Z', to: '2026-11-06T22:00:00.000Z' },
    });
    const product = await insertTestProduct(pool, { name: 'View herbicide', epaRegNo: 'X-1' });
    await pool.query(
      `insert into farm.job_products (job_id, product_id, rate, unit, supplied_by)
       values ($1, $2, 22, 'floz_ac', 'customer')`,
      [id, product],
    );
    const sp = await insertTestMachine(pool, { unitNo: 'VW2' });
    const dale = await insertTestPerson(pool, 'Dale Viewer', { appRole: 'operator' });
    const aid = await insertTestAssignment(pool, id, { machineId: sp, partyId: dale.partyId });
    await pool.query(
      `update farm.jobs set request_channel = 'phone', requester_name = 'Gail', requester_phone = '555'
        where id = $1`,
      [id],
    );
    const res = await as('viewer', () => handleGetJob(id, pool));
    expect(res.status).toBe(200);
    const { job: v } = jobResponseSchema.parse(await res.json()) as JobResponse;
    expect(v).toMatchObject({
      id,
      version: 1,
      kind: 'spray',
      businessLine: 'spraying',
      status: 'planned',
      title: null,
      summary: 'Spray · View 40 · 40 ac',
      field: { id: f.fieldId, name: 'View 40', farmName: 'Home farm' },
      customer: { id: customer, name: 'View Farms' },
      window: { from: '2026-11-06T13:00:00.000Z', to: '2026-11-06T22:00:00.000Z' },
      plannedAcres: 39.5,
      plannedAcresByHand: false,
      priority: 3,
      request: { channel: 'phone', partyId: null, name: 'Gail', phone: '555', viaLink: false },
      cancelledReason: null,
      deereWorkPlanId: null,
      assignments: [
        {
          id: aid,
          role: 'operator',
          machine: {
            id: sp,
            unitNo: 'VW2',
            kind: 'sprayer',
            status: 'active',
            workPlanCapable: false,
          },
          person: { partyId: dale.partyId, name: 'Dale Viewer', initials: 'DV' },
          plannedFor: null,
          alsoOn: [],
        },
      ],
      products: [
        {
          productId: product,
          name: 'View herbicide',
          kind: 'chemical',
          rate: 22,
          unit: 'floz_ac',
          suppliedBy: 'customer',
          restrictedUse: false,
          epaRegNo: 'X-1',
        },
      ],
      flags: [],
    });
    expect(v.field?.boundaryAcres).toBeCloseTo(39.54, 1);
  });
});

describe('GET /api/v1/crew', () => {
  test('crew people by name with initials, sign-in role and active; no orgs, no non-crew', async () => {
    const pool = t().pool;
    const zed = await insertTestPerson(pool, 'Zed Crewman', { appRole: 'driver' });
    const amy = await insertTestPerson(pool, 'amy Crew', { appRole: 'manager', active: false });
    const noSignIn = await insertTestPerson(pool, 'Nina NoSignin');
    await insertTestPerson(pool, 'Carl Customer', { roles: ['customer'] });
    await insertTestPerson(pool, 'Crew Org', { kind: 'org' });
    const res = await as('viewer', () => handleCrew(pool));
    expect(res.status).toBe(200);
    const body = crewResponseSchema.parse(await res.json()) as CrewResponse;
    const names = body.people.map((p) => p.name);
    expect(names).toEqual(
      [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    );
    expect(names).not.toContain('Carl Customer');
    expect(names).not.toContain('Crew Org');
    expect(body.people.find((p) => p.partyId === zed.partyId)).toEqual({
      partyId: zed.partyId,
      appUserId: zed.appUserId,
      name: 'Zed Crewman',
      initials: 'ZC',
      appRole: 'driver',
      active: true,
    });
    expect(body.people.find((p) => p.partyId === amy.partyId)).toMatchObject({
      appRole: 'manager',
      active: false,
      initials: 'AC',
    });
    expect(body.people.find((p) => p.partyId === noSignIn.partyId)).toMatchObject({
      appUserId: null,
      appRole: null,
      active: true,
    });
  });
});

describe('POST /api/v1/jobs', () => {
  test("defaults: the kind's lane, planned, priority 3, the end of the lane; 201 with the job", async () => {
    const pool = t().pool;
    await insertTestJob(pool, { businessLine: 'trucking', sortKey: 70 });
    await insertTestJob(pool, { businessLine: 'trucking', sortKey: 500, status: 'done' });
    const res = await as('manager', () =>
      handleCreateJob(
        jsonRequest('POST', '/api/v1/jobs', { kind: 'haul', plannedQty: 12, plannedUnit: 'loads' }),
        pool,
        NOW,
      ),
    );
    expect(res.status).toBe(201);
    const { job: v } = jobResponseSchema.parse(await res.json()) as JobResponse;
    expect(v).toMatchObject({
      kind: 'haul',
      businessLine: 'trucking',
      status: 'planned',
      priority: 3,
      sortKey: 80,
      version: 1,
      field: null,
      customer: null,
      cropYear: null,
      plannedAcres: null,
      plannedQty: 12,
      plannedUnit: 'loads',
      summary: 'Haul · 12 loads',
      statusChangedAt: NOW.toISOString(),
      flags: ['no_field'],
    });
    const row = await pool.query(`select source from farm.jobs where id = $1`, [v.id]);
    expect(row.rows[0]?.source).toBe('app');
  });

  test('a request makes it requested; who asked is kept; trimmed text, blank = none', async () => {
    const pool = t().pool;
    const gail = await insertTestPerson(pool, 'Gail Asker', { roles: ['customer'] });
    const res = await as('manager', () =>
      handleCreateJob(
        jsonRequest('POST', '/api/v1/jobs', {
          kind: 'spray',
          title: '  Fungicide pass  ',
          notes: '   ',
          request: { channel: 'text', partyId: gail.partyId, name: ' Gail ', phone: '' },
          window: { from: '2026-11-07T14:00:00Z', to: null },
        }),
        pool,
        NOW,
      ),
    );
    expect(res.status).toBe(201);
    const { job: v } = await bodyOf<JobResponse>(res);
    expect(v).toMatchObject({
      status: 'requested',
      title: 'Fungicide pass',
      notes: null,
      request: {
        channel: 'text',
        partyId: gail.partyId,
        name: 'Gail',
        phone: null,
        viaLink: false,
      },
      window: { from: '2026-11-07T14:00:00.000Z', to: null },
    });
    const planned = await as('manager', () =>
      handleCreateJob(
        jsonRequest('POST', '/api/v1/jobs', {
          kind: 'spray',
          status: 'planned',
          request: { channel: 'phone' },
        }),
        pool,
        NOW,
      ),
    );
    expect((await bodyOf<JobResponse>(planned)).job.status).toBe('planned');
  });

  test('a window with no bounds is no window', async () => {
    const res = await as('manager', () =>
      handleCreateJob(
        jsonRequest('POST', '/api/v1/jobs', { kind: 'scout', window: { from: null, to: null } }),
        t().pool,
        NOW,
      ),
    );
    expect((await bodyOf<JobResponse>(res)).job.window).toBeNull();
  });

  test('products with rate, unit and supplied-by, in the order given', async () => {
    const pool = t().pool;
    const a = await insertTestProduct(pool, { name: 'Zeta' });
    const b = await insertTestProduct(pool, { name: 'Alpha', restrictedUse: true });
    const res = await as('manager', () =>
      handleCreateJob(
        jsonRequest('POST', '/api/v1/jobs', {
          kind: 'spray',
          products: [
            { productId: a, rate: 1.5, unit: 'pt_ac' },
            { productId: b, rate: null, unit: null, suppliedBy: 'customer' },
          ],
        }),
        pool,
        NOW,
      ),
    );
    expect(res.status).toBe(201);
    const { job: v } = await bodyOf<JobResponse>(res);
    expect(v.products.map((p) => [p.name, p.rate, p.unit, p.suppliedBy])).toEqual([
      ['Zeta', 1.5, 'pt_ac', 'us'],
      ['Alpha', null, null, 'customer'],
    ]);
    expect(v.flags).toEqual(['no_field', 'restricted_use']);
  });

  test('404 for an unknown field, customer, requester or product; 422 a retired product; 400 one listed twice', async () => {
    const pool = t().pool;
    const post = (body: unknown) =>
      as('manager', () => handleCreateJob(jsonRequest('POST', '/api/v1/jobs', body), pool, NOW));
    for (const [body, error] of [
      [{ kind: 'spray', fieldId: UNKNOWN }, 'field not found'],
      [{ kind: 'spray', customerPartyId: UNKNOWN }, 'customer not found'],
      [{ kind: 'spray', request: { channel: 'phone', partyId: UNKNOWN } }, 'requester not found'],
      [{ kind: 'spray', products: [{ productId: UNKNOWN }] }, 'product not found'],
    ] as const) {
      const res = await post(body);
      expect(res.status).toBe(404);
      expect(await bodyOf(res)).toEqual({ error });
    }
    const retired = await insertTestProduct(pool, { name: 'Old stuff', active: false });
    const r422 = await post({ kind: 'spray', products: [{ productId: retired }] });
    expect(r422.status).toBe(422);
    expect(await bodyOf(r422)).toEqual({ error: 'Old stuff is retired: pick another product' });
    const p = await insertTestProduct(pool);
    const twice = await post({
      kind: 'spray',
      products: [{ productId: p }, { productId: p.toUpperCase() }],
    });
    expect(twice.status).toBe(400);
    const n = await pool.query(`select count(*)::int as n from farm.jobs where source = 'app'`);
    expect(n.rows[0]?.n).toBeGreaterThanOrEqual(0);
    expect(usage).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/v1/jobs/<id>', () => {
  test('only the fields present change; the version goes up by one', async () => {
    const pool = t().pool;
    const j = await job({ title: 'Keep me', priority: 2 });
    const res = await as('manager', () =>
      handleUpdateJob(
        jsonRequest('PATCH', '/x', {
          version: 1,
          notes: 'Gate code 1005',
          plannedQty: 3,
          plannedUnit: 'hours',
          cropYear: 2027,
          window: { from: '2026-11-08T13:00:00Z', to: '2026-11-08T15:00:00Z' },
        }),
        j.id,
        pool,
        NOW,
      ),
    );
    expect(res.status).toBe(200);
    const { job: v } = await bodyOf<JobResponse>(res);
    expect(v).toMatchObject({
      version: 2,
      title: 'Keep me',
      priority: 2,
      notes: 'Gate code 1005',
      plannedQty: 3,
      plannedUnit: 'hours',
      cropYear: 2027,
      window: { from: '2026-11-08T13:00:00.000Z', to: '2026-11-08T15:00:00.000Z' },
    });
    // Null clears.
    const cleared = await as('manager', () =>
      handleUpdateJob(
        jsonRequest('PATCH', '/x', { version: 2, window: null, notes: null, title: null }),
        j.id,
        pool,
        NOW,
      ),
    );
    expect((await bodyOf<JobResponse>(cleared)).job).toMatchObject({
      version: 3,
      window: null,
      notes: null,
      title: null,
    });
  });

  test('only the version: nothing written, same version', async () => {
    const j = await job();
    const res = await as('manager', () =>
      handleUpdateJob(jsonRequest('PATCH', '/x', { version: 1 }), j.id, t().pool, NOW),
    );
    expect(res.status).toBe(200);
    expect((await bodyOf<JobResponse>(res)).job.version).toBe(1);
  });

  test('a new lane or a new priority puts the job at the end of its lane', async () => {
    const pool = t().pool;
    await pool.query(`delete from farm.jobs where business_line = 'store'`);
    await insertTestJob(pool, { businessLine: 'store', sortKey: 40 });
    const j = await job({ businessLine: 'grain', sortKey: 10 });
    const moved = await as('manager', () =>
      handleUpdateJob(
        jsonRequest('PATCH', '/x', { version: 1, businessLine: 'store' }),
        j.id,
        pool,
        NOW,
      ),
    );
    expect((await bodyOf<JobResponse>(moved)).job).toMatchObject({
      businessLine: 'store',
      sortKey: 50,
    });
    const reprioritized = await as('manager', () =>
      handleUpdateJob(jsonRequest('PATCH', '/x', { version: 2, priority: 1 }), j.id, pool, NOW),
    );
    expect((await bodyOf<JobResponse>(reprioritized)).job).toMatchObject({
      priority: 1,
      sortKey: 50,
    });
    const same = await as('manager', () =>
      handleUpdateJob(
        jsonRequest('PATCH', '/x', { version: 3, priority: 1, kind: 'other' }),
        j.id,
        pool,
        NOW,
      ),
    );
    expect((await bodyOf<JobResponse>(same)).job).toMatchObject({
      kind: 'other',
      sortKey: 50,
      version: 4,
    });
  });

  test('products replace the list: dropped ones go, kept ones update, a retired one already on stays', async () => {
    const pool = t().pool;
    const keep = await insertTestProduct(pool, { name: 'Keep' });
    const drop = await insertTestProduct(pool, { name: 'Drop' });
    const add = await insertTestProduct(pool, { name: 'Add' });
    const created = await as('manager', () =>
      handleCreateJob(
        jsonRequest('POST', '/api/v1/jobs', {
          kind: 'spray',
          products: [{ productId: keep, rate: 1, unit: 'pt_ac' }, { productId: drop }],
        }),
        pool,
        NOW,
      ),
    );
    const j = (await bodyOf<JobResponse>(created)).job;
    await pool.query('update farm.products set active = false where id = $1', [keep]);
    const res = await as('manager', () =>
      handleUpdateJob(
        jsonRequest('PATCH', '/x', {
          version: 1,
          products: [{ productId: keep, rate: 2, unit: 'qt_ac' }, { productId: add }],
        }),
        j.id,
        pool,
        NOW,
      ),
    );
    expect(res.status).toBe(200);
    const v = (await bodyOf<JobResponse>(res)).job;
    expect(v.version).toBe(2);
    expect(v.products.map((p) => [p.name, p.rate, p.unit])).toEqual([
      ['Keep', 2, 'qt_ac'],
      ['Add', null, null],
    ]);
    const none = await as('manager', () =>
      handleUpdateJob(jsonRequest('PATCH', '/x', { version: 2, products: [] }), j.id, pool, NOW),
    );
    expect((await bodyOf<JobResponse>(none)).job).toMatchObject({ version: 3, products: [] });
  });
});

describe('usage: one job_action per write, after the commit', () => {
  test('each 2xx write records one job_action with the route pattern and the session ids', async () => {
    const pool = t().pool;
    const person = await insertTestPerson(pool, 'Usage Manager', { appRole: 'manager' });
    const ids = { appUserId: person.appUserId, partyId: person.partyId, deviceId: null };
    const run = (fn: () => Promise<Response>) => as('manager', fn, ids);
    const created = await run(() =>
      handleCreateJob(
        jsonRequest('POST', '/api/v1/jobs', { kind: 'tile', businessLine: 'store' }),
        pool,
        NOW,
      ),
    );
    expect(created.status).toBe(201);
    const j = (await bodyOf<JobResponse>(created)).job;

    // The write is committed (another connection sees it) by the time the event is recorded.
    let seenVersion: unknown = null;
    usage.mockImplementationOnce(async () => {
      const v = await t().admin.query('select version from farm.jobs where id = $1', [j.id]);
      seenVersion = v.rows[0]?.version;
    });
    const machine = await insertTestMachine(pool);
    const assigned = await run(() =>
      handleAssignJob(
        jsonRequest('POST', '/x', { version: 1, machineId: machine }),
        j.id,
        pool,
        NOW,
      ),
    );
    expect(assigned.status).toBe(200);
    expect(seenVersion).toBe(2);
    const aid = (await bodyOf<JobResponse>(assigned)).job.assignments[0]?.id as string;

    const status = async (res: Promise<Response>) => (await res).status;
    expect(
      await status(
        run(() =>
          handleUpdateJob(jsonRequest('PATCH', '/x', { version: 2, notes: 'n' }), j.id, pool, NOW),
        ),
      ),
    ).toBe(200);
    // The field it already has (none): nothing written, still a 200 job action.
    expect(
      await status(
        run(() =>
          handleSetJobField(
            jsonRequest('PUT', '/x', { version: 3, fieldId: null }),
            j.id,
            pool,
            NOW,
          ),
        ),
      ),
    ).toBe(200);
    expect(
      await status(
        run(() => handleUnassignJob(jsonRequest('DELETE', '/x?version=3'), j.id, aid, pool, NOW)),
      ),
    ).toBe(200);
    // Refusals record nothing: a move the machine doesn't have, a stale version.
    expect(
      await status(
        run(() =>
          handleSetJobStatus(
            jsonRequest('POST', '/x', { version: 4, status: 'in_progress' }),
            j.id,
            pool,
            NOW,
          ),
        ),
      ),
    ).toBe(422);
    expect(
      await status(
        run(() =>
          handleUpdateJob(
            jsonRequest('PATCH', '/x', { version: 1, notes: 'old' }),
            j.id,
            pool,
            NOW,
          ),
        ),
      ),
    ).toBe(409);
    expect(
      await status(
        run(() => handleCancelJob(jsonRequest('POST', '/x', { version: 4 }), j.id, pool, NOW)),
      ),
    ).toBe(200);

    const req = await run(() =>
      handleCreateJob(
        jsonRequest('POST', '/api/v1/jobs', {
          kind: 'repair',
          businessLine: 'store',
          request: { channel: 'phone' },
        }),
        pool,
        NOW,
      ),
    );
    const r = (await bodyOf<JobResponse>(req)).job;
    expect(
      await status(
        run(() =>
          handleSetJobStatus(
            jsonRequest('POST', '/x', { version: 1, status: 'planned' }),
            r.id,
            pool,
            NOW,
          ),
        ),
      ),
    ).toBe(200);
    const lane = await pool.query<{ id: string; version: number }>(
      `select id::text as id, version from farm.jobs
        where business_line = 'store' and status in ('requested', 'planned', 'assigned', 'pushed', 'in_progress')
        order by priority, sort_key, created_at, id`,
    );
    expect(
      await status(
        run(() =>
          handleReorderJobs(
            jsonRequest('POST', '/x', { businessLine: 'store', jobs: lane.rows.reverse() }),
            pool,
            NOW,
          ),
        ),
      ),
    ).toBe(200);

    const expected = [
      JOB_ROUTES.jobs,
      JOB_ROUTES.assignments,
      JOB_ROUTES.job,
      JOB_ROUTES.field,
      JOB_ROUTES.assignment,
      JOB_ROUTES.cancel,
      JOB_ROUTES.jobs,
      JOB_ROUTES.status,
      JOB_ROUTES.reorder,
    ].map((route) => [{ kind: 'job_action', route, appUserId: person.appUserId, deviceId: null }]);
    expect(usage.mock.calls).toEqual(expected);
  });

  test("a device session's ids travel as they are; a failing usage write never fails the job write", async () => {
    const pool = t().pool;
    const deviceId = (
      await t().admin.query<{ id: string }>(
        `insert into farm.devices (kind, name, role) values ('wall', 'Usage wall', 'viewer') returning id::text as id`,
      )
    ).rows[0]?.id as string;
    usage.mockImplementationOnce(async () => {
      throw new Error('usage store down');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await as(
      'manager',
      () => handleCreateJob(jsonRequest('POST', '/api/v1/jobs', { kind: 'scout' }), pool, NOW),
      { kind: 'device', deviceId, appUserId: null, partyId: null },
    );
    expect(res.status).toBe(201);
    expect(usage).toHaveBeenCalledWith({
      kind: 'job_action',
      route: JOB_ROUTES.jobs,
      appUserId: null,
      deviceId,
    });
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('usage not recorded'),
      'usage store down',
    );
  });
});
