/**
 * The job writers' transaction (src/db/queries/work-jobs-tx.ts; docs/contracts-2a.md §4.7 rule
 * 4): commit, rollbackWith, errors; a REAL deadlock (two transactions locking two jobs in
 * opposite orders) is retried once and both writes land; a second deadlock is reported, and the
 * route then answers 409 with the job as it is, never a 503.
 */
import { describe, expect, test, vi } from 'vitest';
import { handleUpdateJob } from '../../app/api/v1/jobs/handler';
import { jsonRequest } from '../../app/api/v1/jobs/test-requests';
import { makeSession, runWithSession } from '../../platform/auth/testing';
import type { Role, Session } from '../../platform/auth/types';
import { setupTestDb } from '../../test/db';
import type { JobConflictResponse } from '../../ui/work/contract';
import { insertTestJob } from './work-jobs-testkit';
import { DEADLOCK_DETECTED, isDeadlock, rollbackWith, runJobTransaction } from './work-jobs-tx';

let forceDeadlock = false;
vi.mock('./work-jobs-tx', async (importOriginal) => {
  const real = await importOriginal<typeof import('./work-jobs-tx')>();
  return {
    ...real,
    runJobTransaction: ((...args: Parameters<typeof real.runJobTransaction>) =>
      forceDeadlock
        ? Promise.resolve({ ok: false, deadlocked: true })
        : real.runJobTransaction(...args)) as typeof real.runJobTransaction,
  };
});
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

const priorityOf = async (id: string) =>
  (await t().pool.query<{ p: number }>('select priority as p from farm.jobs where id = $1', [id]))
    .rows[0]?.p;

describe('runJobTransaction', () => {
  test('commits what the body wrote and returns its value', async () => {
    const id = await insertTestJob(t().pool);
    const out = await runJobTransaction(t().pool, async (c) => {
      await c.query('update farm.jobs set priority = 1 where id = $1', [id]);
      return 'done';
    });
    expect(out).toEqual({ ok: true, value: 'done' });
    expect(await priorityOf(id)).toBe(1);
  });

  test('rollbackWith keeps nothing and returns its result; other errors roll back and throw', async () => {
    const id = await insertTestJob(t().pool);
    const out = await runJobTransaction(t().pool, async (c) => {
      await c.query('update farm.jobs set priority = 2 where id = $1', [id]);
      return rollbackWith('refused');
    });
    expect(out).toEqual({ ok: true, value: 'refused' });
    expect(await priorityOf(id)).toBe(3);
    await expect(
      runJobTransaction(t().pool, async (c) => {
        await c.query('update farm.jobs set priority = 2 where id = $1', [id]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await priorityOf(id)).toBe(3);
  });

  test('a real deadlock: the aborted transaction is retried once and both writes land', async () => {
    const [x, y] = [await insertTestJob(t().pool), await insertTestJob(t().pool)] as [
      string,
      string,
    ];
    // Each transaction locks its first job (`for update`: no trigger, so no topic row yet),
    // waits until the other holds its own, then updates the other's job: a lock cycle that
    // Postgres breaks with 40P01 (after deadlock_timeout). The out-of-order locking is the
    // point here; the writers in work-jobs.ts never do it.
    let arrived = 0;
    let release: () => void = () => {};
    const bothHoldOne = new Promise<void>((r) => {
      release = r;
    });
    const barrier = async () => {
      arrived++;
      if (arrived === 2) release();
      await Promise.race([bothHoldOne, new Promise((r) => setTimeout(r, 5_000))]);
    };
    const deadlocks: number[] = [];
    const write = (first: string, second: string, priority: number) =>
      runJobTransaction(
        t().pool,
        async (c) => {
          await c.query('select 1 from farm.jobs where id = $1 for update', [first]);
          if (deadlocks.length === 0) await barrier();
          await c.query('update farm.jobs set priority = $2 where id = $1', [second, priority]);
          await c.query('update farm.jobs set priority = $2 where id = $1', [first, priority]);
          return priority;
        },
        { onDeadlock: (attempt) => deadlocks.push(attempt) },
      );
    const [a, b] = await Promise.all([write(x, y, 1), write(y, x, 2)]);
    expect(deadlocks).toEqual([1]);
    expect(a.ok && b.ok).toBe(true);
    // The retried one committed last: both rows carry its priority.
    const px = await priorityOf(x);
    expect([1, 2]).toContain(px);
    expect(await priorityOf(y)).toBe(px);
  }, 30_000);

  test('a second deadlock is reported, not thrown', async () => {
    const tries: number[] = [];
    const out = await runJobTransaction(
      t().pool,
      async () => {
        throw Object.assign(new Error('deadlock detected'), { code: DEADLOCK_DETECTED });
      },
      { onDeadlock: (n) => tries.push(n) },
    );
    expect(out).toEqual({ ok: false, deadlocked: true });
    expect(tries).toEqual([1, 2]);
    expect(isDeadlock({ code: '40P01' })).toBe(true);
    expect(isDeadlock(new Error('x'))).toBe(false);
    expect(isDeadlock(null)).toBe(false);
  });
});

describe('the route after two deadlocks', () => {
  test('answers 409 with the job as it is then (never a 503)', async () => {
    const id = await insertTestJob(t().pool, { title: 'As it is' });
    forceDeadlock = true;
    try {
      const res = await as('manager', () =>
        handleUpdateJob(jsonRequest('PATCH', '/x', { version: 1, title: 'Lost' }), id, t().pool),
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as JobConflictResponse;
      expect(body.job).toMatchObject({ id, title: 'As it is', version: 1 });
    } finally {
      forceDeadlock = false;
    }
  });
});
