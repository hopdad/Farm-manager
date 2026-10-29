/**
 * src/db/leases.ts against the real functions: the job lease and the stream lease are separate
 * rows (the route and runSyncStep never collide), helpers work on a pg pool and inside a
 * Drizzle transaction, and the cursor only advances while the lease is held.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { setupTestDb } from '../test/db';
import {
  advanceCursor,
  claimDue,
  cursorOf,
  ensureStream,
  JOB_LEASE_MODE,
  JOB_LEASE_SOURCE,
  jobLeaseSeconds,
  releaseLease,
} from './leases';

const t = setupTestDb(import.meta.url);

describe('job and stream leases', () => {
  test('the route (job row) and runSyncStep (stream row) both get their lease', async () => {
    const { pool } = t();
    // Route: before the 202.
    await ensureStream(pool, JOB_LEASE_SOURCE, 'fleet.trucks', JOB_LEASE_MODE);
    const job = await claimDue(pool, JOB_LEASE_SOURCE, 'fleet.trucks', jobLeaseSeconds(45_000));
    expect(job).not.toBeNull();
    expect(job?.source).toBe('job');
    expect(job?.mode).toBe('live');
    expect(job?.leaseUntil.getTime()).toBeGreaterThan(Date.now() + 70_000);
    // A second firing of the same job while it runs: busy.
    expect(await claimDue(pool, JOB_LEASE_SOURCE, 'fleet.trucks', 75)).toBeNull();

    // runSyncStep inside run(ctx): its own row.
    await ensureStream(pool, 'samsara', 'positions', 'sim');
    const stream = await claimDue(pool, 'samsara', 'positions', 90);
    expect(stream).not.toBeNull();
    expect(cursorOf(stream as NonNullable<typeof stream>)).toBeNull();
    // Another job touching the same stream: held elsewhere.
    expect(await claimDue(pool, 'samsara', 'positions', 90)).toBeNull();

    expect(await advanceCursor(pool, stream as NonNullable<typeof stream>, 'page-2')).toBe(true);
    expect(await releaseLease(pool, stream as NonNullable<typeof stream>, { ok: true })).toBe(true);
    expect(await releaseLease(pool, job as NonNullable<typeof job>, { ok: true })).toBe(true);

    const next = await claimDue(pool, 'samsara', 'positions', 90);
    expect(next && cursorOf(next)).toBe('page-2');
    expect(next?.lastOkAt).toBeInstanceOf(Date);
    await releaseLease(pool, next as NonNullable<typeof next>, {
      ok: false,
      error: 'HTTP 429',
      nextRunAt: new Date(Date.now() + 60_000),
    });
    // Backoff: not due yet.
    expect(await claimDue(pool, 'samsara', 'positions', 90)).toBeNull();
    const row = await pool.query(
      `select last_error, next_run_at > now() as later from ingest.sync_state
        where source = 'samsara' and stream = 'positions'`,
    );
    expect(row.rows[0]).toEqual({ last_error: 'HTTP 429', later: true });
  });

  test('works inside a Drizzle transaction; a lost lease cannot advance the cursor', async () => {
    const { db, pool } = t();
    await ensureStream(db, 'deere', 'locations', 'sim');
    const lease = await db.transaction(async (tx) => {
      const l = await claimDue(tx, 'deere', 'locations', 90);
      expect(l?.leaseUntil).toBeInstanceOf(Date); // Drizzle returns text timestamps; mapped
      expect(await advanceCursor(tx, l as NonNullable<typeof l>, 'c1')).toBe(true);
      await tx.execute(sql`select 1`);
      return l as NonNullable<typeof l>;
    });
    // Someone else takes over after expiry.
    await pool.query(
      `update ingest.sync_state set lease_until = now() - interval '1 second'
        where source = 'deere' and stream = 'locations'`,
    );
    const thief = await claimDue(pool, 'deere', 'locations', 90);
    expect(thief).not.toBeNull();
    expect(await advanceCursor(pool, lease, 'stale-write')).toBe(false);
    expect(await releaseLease(pool, lease, { ok: true })).toBe(false);
    expect(thief && cursorOf(thief)).toBe('c1');
  });

  test("mode 'off' is never claimed; ensureStream switches modes", async () => {
    const { pool } = t();
    await ensureStream(pool, 'nws', 'forecast', 'off');
    expect(await claimDue(pool, 'nws', 'forecast', 90)).toBeNull();
    await ensureStream(pool, 'nws', 'forecast', 'sim');
    expect(await claimDue(pool, 'nws', 'forecast', 90)).not.toBeNull();
    await expect(claimDue(pool, 'nws', 'forecast', 0)).rejects.toThrow(RangeError);
  });
});
