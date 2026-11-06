/**
 * The status routes (decision 2a-3, roles 2a-2; docs/contracts-2a.md §4.3, §5.2, §11.1):
 * POST …/status for a manager, a driver or operator on their own job and on another's, a
 * session with no person; its refusals (cancelled always 422 "use /cancel", planned -> assigned,
 * a work_plan or billing move as a person, the same status); POST …/cancel from every open
 * status, with its reason, and 422 closed; a done job stays in its lane for the farm day.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  insertTestAssignment,
  insertTestJob,
  insertTestMachine,
  insertTestPerson,
} from '@/db/queries/work-jobs-testkit';
import { JOB_STATUSES, type JobStatus, OPEN_JOB_STATUSES } from '@/domain/work-jobs';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import type { Role, Session } from '@/platform/auth/types';
import { recordUsage } from '@/platform/usage/record';
import { setupTestDb } from '@/test/db';
import { type BoardSnapshot, JOB_CONFLICT_MESSAGE, type JobView } from '@/ui/work/contract';
import { handleBoardSnapshot, handleCancelJob, handleSetJobStatus } from './handler';
import { jsonRequest } from './test-requests';

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
const NOW = new Date('2026-11-06T14:30:00Z');

beforeEach(() => vi.mocked(recordUsage).mockClear());

async function call(
  role: Role,
  fn: () => Promise<Response>,
  overrides: Partial<Session> = {},
): Promise<{ status: number; body: { error?: string; reason?: string; job: JobView } }> {
  const res = await as(role, fn, overrides);
  return { status: res.status, body: (await res.json()) as never };
}

const setStatus = (
  id: string,
  version: number,
  status: JobStatus,
  role: Role,
  o: Partial<Session> = {},
) =>
  call(
    role,
    () => handleSetJobStatus(jsonRequest('POST', '/x', { version, status }), id, t().pool, NOW),
    o,
  );
const cancel = (id: string, body: unknown, role: Role = 'manager') =>
  call(role, () => handleCancelJob(jsonRequest('POST', '/x', body), id, t().pool, NOW));

/** A job in `status` with a crew person (and a machine) on it. */
async function jobWithCrew(status: JobStatus) {
  const pool = t().pool;
  const person = await insertTestPerson(pool, `Crew ${Math.random().toString(16).slice(2, 6)}`, {
    appRole: 'driver',
  });
  const id = await insertTestJob(pool, {
    status,
    statusChangedAt: new Date('2026-11-01T12:00:00Z'),
  });
  await insertTestAssignment(pool, id, {
    machineId: await insertTestMachine(pool),
    partyId: person.partyId,
  });
  return { id, person };
}

describe('POST …/status as a manager', () => {
  test('accept a request, start, finish and reopen a job; status_changed_at moves each time', async () => {
    const { id } = await jobWithCrew('requested');
    const accepted = await setStatus(id, 1, 'planned', 'manager');
    expect(accepted.status).toBe(200);
    expect(accepted.body.job).toMatchObject({
      status: 'planned',
      version: 2,
      statusChangedAt: NOW.toISOString(),
    });
    const { id: a } = await jobWithCrew('assigned');
    expect((await setStatus(a, 1, 'in_progress', 'manager')).body.job.status).toBe('in_progress');
    expect((await setStatus(a, 2, 'done', 'manager')).body.job.status).toBe('done');
    expect((await setStatus(a, 3, 'in_progress', 'manager')).body.job.status).toBe('in_progress');
    const { id: p } = await jobWithCrew('pushed');
    expect((await setStatus(p, 1, 'in_progress', 'owner')).body.job.status).toBe('in_progress');
  });

  test('refusals: cancelled (use /cancel), planned -> assigned, a work_plan or billing move, the same status', async () => {
    const { id: planned } = await jobWithCrew('planned');
    const c = await setStatus(planned, 1, 'cancelled', 'manager');
    expect(c).toMatchObject({
      status: 422,
      body: { error: 'use /cancel to cancel a job', reason: 'not_allowed' },
    });
    const auto = await setStatus(planned, 1, 'assigned', 'manager');
    expect(auto).toMatchObject({ status: 422, body: { reason: 'not_allowed' } });
    expect(auto.body.error).toMatch(/by itself/);
    const { id: assigned } = await jobWithCrew('assigned');
    const push = await setStatus(assigned, 1, 'pushed', 'owner');
    expect(push).toMatchObject({ status: 422, body: { reason: 'not_allowed' } });
    expect(push.body.error).toMatch(/Work Plan/);
    const back = await setStatus(assigned, 1, 'planned', 'manager');
    expect(back.body.reason).toBe('not_allowed');
    const { id: done } = await jobWithCrew('done');
    const bill = await setStatus(done, 1, 'invoiced', 'manager');
    expect(bill).toMatchObject({ status: 422, body: { reason: 'not_allowed' } });
    expect(bill.body.error).toMatch(/billing/);
    const same = await setStatus(done, 1, 'done', 'manager');
    expect(same).toMatchObject({ status: 422, body: { reason: 'same' } });
    for (const to of JOB_STATUSES) {
      if (to === 'requested') continue;
      const { id } = await jobWithCrew('cancelled');
      const r = await setStatus(id, 1, to, 'manager');
      expect(r.status, `cancelled -> ${to}`).toBe(422);
    }
  });

  test('a stale version is 409 with the job; cancelled is refused even then', async () => {
    const { id } = await jobWithCrew('assigned');
    const r = await setStatus(id, 7, 'in_progress', 'manager');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(JOB_CONFLICT_MESSAGE);
    expect(r.body.job).toMatchObject({ id, version: 1, status: 'assigned' });
    expect((await setStatus(id, 7, 'cancelled', 'driver')).status).toBe(422);
  });
});

describe('POST …/status below a manager: own job only', () => {
  for (const role of ['driver', 'operator'] as const) {
    test(`a ${role} starts and finishes their own job, and may do nothing else`, async () => {
      const { id, person } = await jobWithCrew('assigned');
      const me = { partyId: person.partyId, appUserId: person.appUserId };
      const start = await setStatus(id, 1, 'in_progress', role, me);
      expect(start).toMatchObject({ status: 200, body: { job: { status: 'in_progress' } } });
      const finish = await setStatus(id, 2, 'done', role, {
        partyId: person.partyId.toUpperCase(),
      });
      expect(finish).toMatchObject({ status: 200, body: { job: { status: 'done' } } });
      // Reopening is a manager's (a mistake to fix).
      const reopen = await setStatus(id, 3, 'in_progress', role, me);
      expect(reopen.status).toBe(403);
      expect(reopen.body).toEqual({ error: 'only a manager can make this change' });
      const { id: pushed } = await jobWithCrew('pushed');
      const other = await setStatus(pushed, 1, 'in_progress', role, me);
      expect(other.status).toBe(403);
      expect(other.body).toEqual({ error: 'only the people on this job can change it' });
      // Accepting a request is a manager's, even on their own job.
      const req = await jobWithCrew('requested');
      const accept = await setStatus(req.id, 1, 'planned', role, { partyId: req.person.partyId });
      expect(accept.status).toBe(403);
    });
  }

  test('a session with no person (a shared screen nobody signed in on) has no own job', async () => {
    const { id } = await jobWithCrew('assigned');
    const r = await setStatus(id, 1, 'in_progress', 'driver', {
      kind: 'device',
      deviceId: null,
      partyId: null,
      appUserId: null,
    });
    expect(r.status).toBe(403);
    expect(vi.mocked(recordUsage)).not.toHaveBeenCalled();
  });

  test('a viewer may not call it at all', async () => {
    const { id, person } = await jobWithCrew('assigned');
    const r = await setStatus(id, 1, 'in_progress', 'viewer', { partyId: person.partyId });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ required: 'driver' });
  });
});

describe('POST …/cancel', () => {
  test('from every open status, with the reason (trimmed; blank = none)', async () => {
    for (const from of OPEN_JOB_STATUSES) {
      const { id } = await jobWithCrew(from);
      const r = await cancel(id, { version: 1, reason: '  Customer called it off ' });
      expect(r.status, from).toBe(200);
      expect(r.body.job).toMatchObject({
        status: 'cancelled',
        cancelledReason: 'Customer called it off',
        statusChangedAt: NOW.toISOString(),
        version: 2,
      });
    }
    const { id } = await jobWithCrew('planned');
    expect((await cancel(id, { version: 1, reason: ' ' })).body.job.cancelledReason).toBeNull();
  });

  test('a done, invoiced or cancelled job is 422 closed; stale 409; a driver 403', async () => {
    for (const from of ['done', 'invoiced', 'cancelled'] as const) {
      const { id } = await jobWithCrew(from);
      const r = await cancel(id, { version: 1 });
      expect(r, from).toMatchObject({ status: 422, body: { reason: 'closed' } });
    }
    const { id } = await jobWithCrew('assigned');
    expect((await cancel(id, { version: 2 })).status).toBe(409);
    expect((await cancel(id, { version: 1 }, 'driver')).status).toBe(403);
  });
});

describe('the board after status moves', () => {
  test('a job done today stays in its lane (after the open ones); a cancelled one leaves the board', async () => {
    const pool = t().pool;
    await pool.query(`delete from farm.jobs`);
    const { id: done } = await jobWithCrew('in_progress');
    const { id: gone } = await jobWithCrew('planned');
    const { id: open } = await jobWithCrew('assigned');
    await setStatus(done, 1, 'done', 'manager');
    await cancel(gone, { version: 1 });
    const res = await as('viewer', () =>
      handleBoardSnapshot(jsonRequest('GET', '/api/v1/jobs'), pool, NOW),
    );
    const snap = (await res.json()) as BoardSnapshot;
    expect(snap.lanes[0]?.jobs.map((j) => [j.id, j.status])).toEqual([
      [open, 'assigned'],
      [done, 'done'],
    ]);
    // The next farm day it is gone too.
    const tomorrow = new Date('2026-11-07T06:00:00Z');
    const next = await as('viewer', () =>
      handleBoardSnapshot(jsonRequest('GET', '/api/v1/jobs'), pool, tomorrow),
    );
    expect(((await next.json()) as BoardSnapshot).lanes[0]?.jobs.map((j) => j.id)).toEqual([open]);
  });
});
