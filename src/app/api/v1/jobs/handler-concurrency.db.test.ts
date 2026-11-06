/**
 * Optimistic concurrency and the lock order (decision 2a-7; docs/contracts-2a.md §4.7, §11.1),
 * with real parallel requests (Promise.all over the pool): two writers with the same version,
 * one wins and the other gets 409 with the winner's job, for the job row, an assignment and a
 * reorder; two reorders listing a lane in opposite orders, and a reorder against a single
 * assign on one of its jobs, never answer 503 nor hit a deadlock (no retry is even needed: the
 * lock order holds); and reorder's full-list rules.
 */
import { afterEach, beforeEach, describe, expect, type MockInstance, test, vi } from 'vitest';
import { insertTestJob, insertTestMachine } from '@/db/queries/work-jobs-testkit';
import type { BusinessLine } from '@/domain/work-jobs';
import { makeSession, runWithSession } from '@/platform/auth/testing';
import type { Role, Session } from '@/platform/auth/types';
import { recordUsage } from '@/platform/usage/record';
import { setupTestDb } from '@/test/db';
import {
  type BoardSnapshot,
  boardSnapshotSchema,
  JOB_CONFLICT_MESSAGE,
  type JobConflictResponse,
  type JobResponse,
} from '@/ui/work/contract';
import {
  handleAssignJob,
  handleCreateJob,
  handleGetJob,
  handleReorderJobs,
  handleUpdateJob,
} from './handler';
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
const ROUNDS = 12;

let warn: MockInstance<typeof console.warn>;
let error: MockInstance<typeof console.error>;
beforeEach(() => {
  vi.mocked(recordUsage).mockClear();
  warn = vi.spyOn(console, 'warn');
  error = vi.spyOn(console, 'error');
});
afterEach(() => {
  // No deadlock retry and no 503 anywhere in this file.
  expect(warn.mock.calls.filter((c) => String(c[0]).includes('deadlock'))).toEqual([]);
  expect(error).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

const manager = <T>(fn: () => Promise<T>) => as('manager', fn);

async function current(id: string) {
  const res = await as('viewer', () => handleGetJob(id, t().pool));
  return ((await res.json()) as JobResponse).job;
}

/**
 * A fresh lane of `n` open jobs (one priority), ids in lane order, sort keys 5, 15, 25, … (any
 * reorder moves them all) or, `settled`, 10, 20, 30, … (a reorder moves only what it swaps).
 */
async function lane(line: BusinessLine, n: number, settled = false): Promise<string[]> {
  await t().pool.query('delete from farm.jobs where business_line = $1', [line]);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const sortKey = settled ? (i + 1) * 10 : 5 + i * 10;
    ids.push(await insertTestJob(t().pool, { businessLine: line, sortKey }));
  }
  return ids;
}

async function versions(ids: string[]) {
  const r = await t().pool.query<{ id: string; version: number }>(
    'select id::text as id, version from farm.jobs where id = any($1::uuid[])',
    [ids],
  );
  const byId = new Map(r.rows.map((x) => [x.id, x.version]));
  return ids.map((id) => ({ id, version: byId.get(id) as number }));
}

const reorder = (line: BusinessLine, jobs: { id: string; version: number }[]) =>
  manager(() =>
    handleReorderJobs(
      jsonRequest('POST', '/api/v1/jobs/reorder', { businessLine: line, jobs }),
      t().pool,
      NOW,
    ),
  );

describe('two writers with the same version: one wins, the other 409s with the winner', () => {
  test('the job row (PATCH)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await insertTestJob(t().pool);
      const [a, b] = await Promise.all(
        ['Alpha', 'Bravo'].map((title) =>
          manager(() =>
            handleUpdateJob(jsonRequest('PATCH', '/x', { version: 1, title }), id, t().pool, NOW),
          ),
        ),
      );
      const statuses = [a?.status, b?.status].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = (a?.status === 409 ? a : b) as Response;
      const winner = (a?.status === 200 ? a : b) as Response;
      const lost = (await loser.json()) as JobConflictResponse;
      const won = ((await winner.json()) as JobResponse).job;
      expect(lost.error).toBe(JOB_CONFLICT_MESSAGE);
      expect(lost.job).toMatchObject({ version: 2, title: won.title });
      expect(await current(id)).toMatchObject({ version: 2, title: won.title });
    }
  });

  test('an assignment (two machine chips at once)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await insertTestJob(t().pool);
      const machines = [await insertTestMachine(t().pool), await insertTestMachine(t().pool)];
      const res = await Promise.all(
        machines.map((machineId) =>
          manager(() =>
            handleAssignJob(
              jsonRequest('POST', '/x', { version: 1, machineId }),
              id,
              t().pool,
              NOW,
            ),
          ),
        ),
      );
      expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
      const job = await current(id);
      expect(job.version).toBe(2);
      expect(job.assignments).toHaveLength(1);
    }
  });

  test('a reorder (the same lane, listed twice with the same versions)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const ids = await lane('store', 3);
      const listed = await versions(ids);
      const res = await Promise.all([
        reorder('store', [...listed].reverse()),
        reorder('store', [listed[1], listed[0], listed[2]] as typeof listed),
      ]);
      expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    }
  });
});

describe('the lock order: never a 503 or a deadlock reaching the client', () => {
  test('two reorders listing the same lane in opposite orders', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const ids = await lane('trucking', 6);
      const listed = await versions(ids);
      const res = await Promise.all([
        reorder('trucking', listed),
        reorder('trucking', [...listed].reverse()),
      ]);
      // Both move every job's sort key, so the second to commit is stale.
      expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = res.find((r) => r.status === 200) as Response;
      const snap = boardSnapshotSchema.parse(await winner.json()) as BoardSnapshot;
      const order = snap.lanes.find((l) => l.businessLine === 'trucking')?.jobs.map((j) => j.id);
      expect([ids, [...ids].reverse()]).toContainEqual(order);
    }
  });

  test('a reorder against a single assign on one of its jobs', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      // Even rounds: the reorder moves the assigned job; odd rounds: it swaps two other jobs and
      // leaves the assigned one where it is. Either way it lists the job with the version it saw,
      // so whichever commits second may find its version stale (409); never both, never a 503.
      const moves = round % 2 === 0;
      const ids = await lane('grain', 5, !moves);
      const listed = await versions(ids);
      const machine = await insertTestMachine(t().pool);
      const target = ids[moves ? 2 : 0] as string;
      const order = moves
        ? [...listed.filter((l) => l.id !== target), ...listed.filter((l) => l.id === target)]
        : [listed[0], listed[1], listed[2], listed[4], listed[3]];
      const [r, a] = await Promise.all([
        reorder('grain', order as typeof listed),
        manager(() =>
          handleAssignJob(
            jsonRequest('POST', '/x', { version: 1, machineId: machine }),
            target,
            t().pool,
            NOW,
          ),
        ),
      ]);
      for (const res of [r, a]) expect([200, 409]).toContain(res?.status);
      expect([r?.status, a?.status]).toContain(200);
      if (r?.status === 409) {
        expect(((await r.json()) as JobConflictResponse).job.id).toBe(target);
      }
      const job = await current(target);
      expect(job.assignments.length).toBe(a?.status === 200 ? 1 : 0);
    }
  });

  test('a reorder that leaves a job in place keeps its version: an assign that saw it still lands', async () => {
    const ids = await lane('grain', 3, true);
    const listed = await versions(ids);
    const swapped = await reorder('grain', [listed[0], listed[2], listed[1]] as typeof listed);
    expect(swapped.status).toBe(200);
    const machineId = await insertTestMachine(t().pool);
    const res = await manager(() =>
      handleAssignJob(
        jsonRequest('POST', '/x', { version: 1, machineId }),
        ids[0] as string,
        t().pool,
        NOW,
      ),
    );
    expect(res.status).toBe(200);
  });

  test('many single-job writers on one job and one lane at once', async () => {
    const ids = await lane('spraying', 4);
    const calls = ids.flatMap((id) =>
      [1, 1, 1].map((version, i) =>
        manager(() =>
          handleUpdateJob(
            jsonRequest('PATCH', '/x', { version, notes: `n${i}` }),
            id,
            t().pool,
            NOW,
          ),
        ),
      ),
    );
    const res = await Promise.all([...calls, reorder('spraying', await versions(ids))]);
    for (const r of res) expect([200, 409]).toContain(r.status);
    // One PATCH per job won.
    for (const id of ids) expect((await current(id)).version).toBeGreaterThanOrEqual(2);
  });
});

describe('reorder: the full-list rule', () => {
  test('sort_key = (position + 1) × 10; only moved jobs get version + 1; the answer is the snapshot', async () => {
    const [a, b, c] = await lane('store', 3);
    // a 5, b 15, c 25 -> [b, a, c] = 10, 20, 30: all move.
    const first = await reorder('store', await versions([b, a, c] as string[]));
    expect(first.status).toBe(200);
    const snap = (await first.json()) as BoardSnapshot;
    expect(
      snap.lanes
        .find((l) => l.businessLine === 'store')
        ?.jobs.map((j) => [j.id, j.sortKey, j.version]),
    ).toEqual([
      [b, 10, 2],
      [a, 20, 2],
      [c, 30, 2],
    ]);
    // Swap a and c: b keeps 10 and its version.
    const second = await reorder('store', await versions([b, c, a] as string[]));
    const lanes = ((await second.json()) as BoardSnapshot).lanes;
    expect(
      lanes.find((l) => l.businessLine === 'store')?.jobs.map((j) => [j.id, j.sortKey, j.version]),
    ).toEqual([
      [b, 10, 2],
      [c, 20, 3],
      [a, 30, 3],
    ]);
    // The same order again: nothing moves.
    const same = await reorder('store', await versions([b, c, a] as string[]));
    expect(same.status).toBe(200);
    expect((await versions([a, b, c] as string[])).map((v) => v.version)).toEqual([3, 2, 3]);
  });

  test('priority never changes: a move shows only within its priority', async () => {
    const [low, high] = await lane('store', 2);
    await t().pool.query('update farm.jobs set priority = 1 where id = $1', [high]);
    const res = await reorder('store', await versions([low, high] as string[]));
    const jobs = ((await res.json()) as BoardSnapshot).lanes.find(
      (l) => l.businessLine === 'store',
    )?.jobs;
    expect(jobs?.map((j) => [j.id, j.priority])).toEqual([
      [high, 1],
      [low, 3],
    ]);
  });

  test('an open job of the lane missing from the list: 409 with it (a new job lands at the end of its priority)', async () => {
    const ids = await lane('store', 2);
    const listed = await versions(ids);
    const created = await manager(() =>
      handleCreateJob(
        jsonRequest('POST', '/api/v1/jobs', { kind: 'other', businessLine: 'store' }),
        t().pool,
        NOW,
      ),
    );
    const fresh = ((await created.json()) as JobResponse).job;
    expect(fresh.sortKey).toBe(25);
    const res = await reorder('store', [...listed].reverse());
    expect(res.status).toBe(409);
    const body = (await res.json()) as JobConflictResponse;
    expect(body.job.id).toBe(fresh.id);
    expect((await versions(ids)).map((v) => v.version)).toEqual([1, 1]);
  });

  test('a listed job that is not open in that lane: 422 not_in_lane (another lane, closed, unknown)', async () => {
    const ids = await lane('store', 2);
    const elsewhere = await insertTestJob(t().pool, { businessLine: 'grain' });
    const closed = await insertTestJob(t().pool, { businessLine: 'store', status: 'done' });
    const listed = await versions(ids);
    for (const extra of [elsewhere, closed, '00000000-0000-4000-8000-000000000000']) {
      const res = await reorder('store', [...listed, { id: extra, version: 1 }]);
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: 'a listed job is not open in that lane',
        reason: 'not_in_lane',
      });
    }
    const twice = await reorder('store', [...listed, listed[0] as (typeof listed)[number]]);
    expect(twice.status).toBe(400);
  });

  test('a stale listed job: 409 with the first stale one in list order', async () => {
    const ids = await lane('store', 3);
    const listed = await versions(ids);
    await t().pool.query('update farm.jobs set version = version + 1 where id = any($1::uuid[])', [
      [ids[1], ids[2]],
    ]);
    const res = await reorder('store', [listed[0], listed[2], listed[1]] as typeof listed);
    expect(res.status).toBe(409);
    expect(((await res.json()) as JobConflictResponse).job.id).toBe(ids[2]);
  });
});
