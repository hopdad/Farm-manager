/**
 * The job writers' transaction (slice 2a, jobs-api; docs/contracts-2a.md §4.7).
 *
 * Every job write runs in one short transaction on a pooled client. The publish triggers
 * (db/pending/jobs-api.sql) lock the app.topic_seq('jobs') row from a writer's first job
 * statement to its commit, so job writers queue on it; the lock order keeps them from
 * deadlocking (the job row first: the CAS update in a single-job write, `select … for update`
 * in id order in a several-job write). A deadlock (40P01) can still happen against a writer
 * outside that order (a field delete setting `field_id` null while a job is pointed at that
 * field): the whole transaction is retried ONCE, and a second deadlock is reported as
 * `{ deadlocked: true }` (the route answers 409 with the job as it is then, never a 503).
 *
 * The body may end the transaction early with `rollbackWith(result)`: nothing it wrote is kept
 * and `result` is returned (a refusal found after a read: unknown id, stale version, a rule).
 */
import type pg from 'pg';

/** Postgres' deadlock_detected. */
export const DEADLOCK_DETECTED = '40P01';

export function isDeadlock(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === DEADLOCK_DETECTED;
}

class Rollback<R> {
  constructor(readonly result: R) {}
}

/** End the job transaction without keeping anything; `runJobTransaction` returns `result`. */
export function rollbackWith<R>(result: R): never {
  throw new Rollback(result);
}

export type JobTransactionOutcome<R> = { ok: true; value: R } | { ok: false; deadlocked: true };

export interface JobTransactionOptions {
  /** Tries in all (default 2: one retry after a deadlock). */
  attempts?: number;
  /** Told about each deadlock (logging; tests count them). */
  onDeadlock?(attempt: number, e: unknown): void;
}

/** Run `body` in a transaction, retrying the whole of it once after a deadlock. */
export async function runJobTransaction<R>(
  pool: pg.Pool,
  body: (c: pg.PoolClient) => Promise<R>,
  opts: JobTransactionOptions = {},
): Promise<JobTransactionOutcome<R>> {
  const attempts = Math.max(1, opts.attempts ?? 2);
  for (let attempt = 1; ; attempt++) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      try {
        const value = await body(c);
        await c.query('commit');
        return { ok: true, value };
      } catch (e) {
        await c.query('rollback').catch(() => {});
        if (e instanceof Rollback) return { ok: true, value: e.result as R };
        if (!isDeadlock(e)) throw e;
        opts.onDeadlock?.(attempt, e);
        if (attempt >= attempts) return { ok: false, deadlocked: true };
      }
    } finally {
      c.release();
    }
  }
}
