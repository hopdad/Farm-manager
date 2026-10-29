/**
 * The /admin/connectors read model on a real database, as farm_app: streams (mode, last OK,
 * last error, raw counts, counters), jobs (registered + history-only, running, last run, last
 * failure, 1 h / 24 h counts), dead letters and the clock flag.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { claimDue, ensureStream, JOB_LEASE_SOURCE } from '../../../db/leases';
import type { JobRegistry } from '../../../jobs/types';
import { setupTestDb } from '../../../test/db';
import { loadConnectorsSnapshot } from './data';

const t = setupTestDb(import.meta.url);
const run = async () => ({ items: 0 });
const registry: JobRegistry = {
  'fleet.trucks': { every: '30 seconds', run },
  'fleet.deere': { cron: '*/2 * * * *', run },
};
const sha = (n: number) => n.toString(16).padStart(64, '0');

beforeAll(async () => {
  const p = t().pool;
  await p.query(`
    insert into ingest.sync_state (source, stream, mode, last_run_at, last_ok_at, last_error, last_error_at, extra)
    values ('samsara', 'positions', 'sim', now(), now() - interval '5 minutes', 'HTTP 503 from samsara', now(),
            '{"calls": 42, "pages": {"total": 7}, "subscription": "abc"}'),
           ('deere', 'machines', 'off', null, null, null, null, '{}')`);
  await p.query(
    `
    insert into ingest.raw_events (source, stream, external_id, payload, sha256, status, attempts, last_error, fetched_at, processed_at)
    values ('samsara', 'positions', 'v1', '{}', $1, 'pending', 0, null, now(), null),
           ('samsara', 'positions', 'v2', '{}', $2, 'processed', 1, null, now(), now()),
           ('samsara', 'positions', 'v3', '{}', $3, 'dead', 5, 'no machine for vehicle v3', now(), null),
           ('deere', 'webhooks', 'w1', '{}', $4, 'pending', 0, null, now(), null)`,
    [sha(1), sha(2), sha(3), sha(4)],
  );
  await p.query(`
    insert into ingest.job_runs (job, host, started_at, finished_at, ok, items, note, error)
    values ('fleet.trucks', 'app', now() - interval '2 hours', now() - interval '2 hours', true, 5, null, null),
           ('fleet.trucks', 'app', now() - interval '10 minutes', now() - interval '10 minutes', false, null, null, 'samsara: HTTP 503'),
           ('fleet.trucks', 'app', now() - interval '1 minute', now() - interval '1 minute', true, 11, '1 dead-lettered', null),
           ('old.job', 'pc', now() - interval '3 days', now() - interval '3 days', true, 1, null, null)`);
  await ensureStream(p, JOB_LEASE_SOURCE, 'fleet.deere', 'live');
  await claimDue(p, JOB_LEASE_SOURCE, 'fleet.deere', 60);
  await p.query(`update app.settings set value = 'true'::jsonb where key = 'clock.paused'`);
});

describe('loadConnectorsSnapshot', () => {
  test('streams with raw counts and numeric counters; job lease rows are not streams', async () => {
    const s = await loadConnectorsSnapshot(t().pool, registry);
    expect(s.clockPaused).toBe(true);
    expect(s.streams.map((x) => `${x.source}/${x.stream}`)).toEqual([
      'deere/machines',
      'samsara/positions',
      'deere/webhooks',
    ]);
    const samsara = s.streams.find((x) => x.source === 'samsara');
    expect(samsara).toMatchObject({
      mode: 'sim',
      lastError: 'HTTP 503 from samsara',
      counters: { calls: 42, 'pages.total': 7 },
      raw: { pending: 1, dead: 1, processed24h: 1, landed24h: 3 },
    });
    expect(samsara?.lastOkAt).toBeInstanceOf(Date);
    // Raw events without a sync_state row still show up.
    expect(s.streams.find((x) => x.stream === 'webhooks')).toMatchObject({
      mode: '-',
      raw: { pending: 1 },
    });
  });

  test('jobs: registered ones plus history-only ones, with runs, failures and the running flag', async () => {
    const s = await loadConnectorsSnapshot(t().pool, registry);
    expect(s.registryError).toBeNull();
    expect(s.jobs.map((j) => j.name)).toEqual(['fleet.deere', 'fleet.trucks', 'old.job']);
    const trucks = s.jobs.find((j) => j.name === 'fleet.trucks');
    expect(trucks).toMatchObject({
      registered: true,
      schedule: 'every 30 s',
      host: 'app',
      running: false,
      runs1h: 2,
      runs24h: 3,
      failed24h: 1,
      items24h: 16,
      lastRun: { ok: true, items: 11, note: '1 dead-lettered', error: null },
      lastFailure: { error: 'samsara: HTTP 503' },
    });
    expect(s.jobs.find((j) => j.name === 'fleet.deere')).toMatchObject({
      registered: true,
      schedule: '*/2 * * * * UTC',
      running: true,
      lastRun: null,
    });
    expect(s.jobs.find((j) => j.name === 'old.job')).toMatchObject({
      registered: false,
      runs24h: 0,
    });
  });

  test('dead letters, newest first', async () => {
    const s = await loadConnectorsSnapshot(t().pool, registry);
    expect(s.dead).toEqual([
      expect.objectContaining({
        source: 'samsara',
        stream: 'positions',
        externalId: 'v3',
        attempts: 5,
        lastError: 'no machine for vehicle v3',
      }),
    ]);
  });

  test('an invalid registry is reported, not thrown', async () => {
    const bad = { 'x.y': { every: '90 seconds', run } } as unknown as JobRegistry;
    const s = await loadConnectorsSnapshot(t().pool, bad);
    expect(s.registryError).toMatch(/invalid job registry/);
  });
});
