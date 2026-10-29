/**
 * app.claim_due: a single UPDATE ... RETURNING grants exactly one lease under contention;
 * app.release_lease hands it back; mode 'off' and next_run_at gate claims.
 */
import pg from 'pg';
import { describe, expect, test } from 'vitest';
import { setupTestDb } from '../test/db';

const t = setupTestDb(import.meta.url);

async function claim(stream: string, leaseSeconds = 30) {
  const r = await t().pool.query('select * from app.claim_due($1, $2, $3)', [
    'samsara',
    stream,
    leaseSeconds,
  ]);
  return r.rows;
}

describe('app.claim_due', () => {
  test('exactly one of 10 concurrent claims wins', async () => {
    await t().pool.query(`select app.ensure_stream('samsara', 'positions', 'sim')`);
    // Ten separate connections, all released at once.
    const clients = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const c = new pg.Client({ connectionString: t().appUrl });
        await c.connect();
        return c;
      }),
    );
    try {
      const results = await Promise.all(
        clients.map((c) =>
          c.query(`select lease_token from app.claim_due('samsara', 'positions', 30)`),
        ),
      );
      const winners = results.filter((r) => r.rowCount === 1);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.rows[0].lease_token).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  test('a held lease blocks; release_lease (right token) frees it and records the outcome', async () => {
    await t().pool.query(`select app.ensure_stream('samsara', 'stats', 'sim')`);
    const [first] = await claim('stats');
    expect(first).toBeDefined();
    expect(await claim('stats')).toHaveLength(0);
    const wrong = await t().pool.query(
      `select app.release_lease('samsara', 'stats', gen_random_uuid(), true) as ok`,
    );
    expect(wrong.rows[0].ok).toBe(false);
    const right = await t().pool.query(
      `select app.release_lease('samsara', 'stats', $1, false, 'HTTP 503') as ok`,
      [first.lease_token],
    );
    expect(right.rows[0].ok).toBe(true);
    const row = await t().pool.query(
      `select lease_until, last_error, last_error_at, last_ok_at from ingest.sync_state where stream = 'stats'`,
    );
    expect(row.rows[0]).toMatchObject({
      lease_until: null,
      last_error: 'HTTP 503',
      last_ok_at: null,
    });
    expect(await claim('stats')).toHaveLength(1);
  });

  test("mode 'off', a future next_run_at, a missing row and a zero lease are never claimed", async () => {
    const { pool } = t();
    await pool.query(`select app.ensure_stream('samsara', 'off-stream', 'off')`);
    expect(await claim('off-stream')).toHaveLength(0);
    await pool.query(`select app.ensure_stream('samsara', 'later', 'sim')`);
    await pool.query(
      `update ingest.sync_state set next_run_at = now() + interval '1 hour' where stream = 'later'`,
    );
    expect(await claim('later')).toHaveLength(0);
    expect(await claim('does-not-exist')).toHaveLength(0);
    await pool.query(`select app.ensure_stream('samsara', 'zero', 'sim')`);
    expect(await claim('zero', 0)).toHaveLength(0);
  });

  test('an expired lease can be claimed again', async () => {
    const { pool } = t();
    await pool.query(`select app.ensure_stream('samsara', 'expiring', 'sim')`);
    expect(await claim('expiring')).toHaveLength(1);
    await pool.query(
      `update ingest.sync_state set lease_until = now() - interval '1 second' where stream = 'expiring'`,
    );
    expect(await claim('expiring')).toHaveLength(1);
  });

  test('ensure_stream updates the mode', async () => {
    const { pool } = t();
    await pool.query(`select app.ensure_stream('deere', 'locations', 'sim')`);
    await pool.query(`select app.ensure_stream('deere', 'locations', 'replay')`);
    const r = await pool.query(`select mode from ingest.sync_state where source = 'deere'`);
    expect(r.rows).toEqual([{ mode: 'replay' }]);
  });
});
