/**
 * POST /api/jobs/<name> against a real database (docs/contracts.md §5): paused, accepted,
 * busy (the job lease is held: 202 { skipped: 'busy' }, not 409), the after() work recording
 * one ingest.job_runs row and releasing the lease, failures, the deadline signal, and the
 * clock.paused setting with its admin/clock publish.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { claimDue, ensureStream, JOB_LEASE_SOURCE, jobLeaseSeconds } from '../../../../db/leases';
import type { JobContext, JobRegistry, JobResult } from '../../../../jobs/types';
import { LOCAL_NOTIFY_CHANNEL, type NotifyMessage } from '../../../../platform/realtime/types';
import { setupTestDb } from '../../../../test/db';
import { readClockPaused, setClockPaused } from './clock-setting';
import { handleJobPost, type JobRouteDeps } from './run-job';

const t = setupTestDb(import.meta.url);
const SECRET = 'j'.repeat(64);
const quiet = () => ({ debug() {}, info() {}, warn() {}, error() {} });

/** Collects the after() tasks; like Next's after(), they run only after the response (settle). */
function harness(registry: JobRegistry) {
  const tasks: (() => Promise<void>)[] = [];
  const deps: JobRouteDeps = {
    registry,
    secret: SECRET,
    pool: t().pool,
    jobsPool: t().pool,
    jobsDb: t().db,
    schedule: (task) => {
      tasks.push(task);
    },
    logger: quiet,
  };
  const post = (name: string) =>
    handleJobPost(
      new Request(`http://x/api/jobs/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      name,
      deps,
    );
  return { post, settle: () => Promise.all(tasks.splice(0).map((task) => task())), tasks };
}

async function runs(job: string) {
  const r = await t().pool.query(
    'select job, host, started_at, finished_at, ok, items, note, error from ingest.job_runs where job = $1 order by started_at',
    [job],
  );
  return r.rows;
}

async function jobRow(job: string) {
  const r = await t().pool.query(
    'select mode, lease_until, lease_token, last_ok_at, last_error from ingest.sync_state where source = $1 and stream = $2',
    [JOB_LEASE_SOURCE, job],
  );
  return r.rows[0];
}

beforeEach(async () => {
  await t().pool.query(`update app.settings set value = 'false'::jsonb where key = 'clock.paused'`);
});

describe('POST /api/jobs/<name>', () => {
  test('accepted: 202, then the run records one job_runs row and releases the lease', async () => {
    let seen: JobContext | undefined;
    const h = harness({
      'demo.ok': {
        every: '5 seconds',
        budgetMs: 2_000,
        run: async (ctx): Promise<JobResult> => {
          seen = ctx;
          return { items: 3, note: 'three' };
        },
      },
    });
    const res = await h.post('demo.ok');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, name: 'demo.ok' });
    // The lease is held until the after() work releases it.
    expect((await jobRow('demo.ok')).lease_token).not.toBeNull();
    await h.settle();

    expect(seen?.name).toBe('demo.ok');
    expect(seen?.deadline.getTime()).toBeGreaterThan(Date.now() - 1_000);
    expect(seen?.signal.aborted).toBe(false);
    const rows = await runs('demo.ok');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      job: 'demo.ok',
      host: 'app',
      ok: true,
      items: 3,
      note: 'three',
      error: null,
    });
    expect(rows[0].finished_at.getTime()).toBeGreaterThanOrEqual(rows[0].started_at.getTime());
    const row = await jobRow('demo.ok');
    expect(row).toMatchObject({
      mode: 'live',
      lease_token: null,
      lease_until: null,
      last_error: null,
    });
    expect(row.last_ok_at).not.toBeNull();
  });

  test('busy: a second POST while the first run holds the lease is 202 skipped busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      'demo.slow': {
        cron: '* * * * *',
        run: async () => {
          await gate;
          return { items: 1 };
        },
      },
    });
    expect((await h.post('demo.slow')).status).toBe(202);
    const second = await h.post('demo.slow');
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ skipped: 'busy', name: 'demo.slow' });
    expect(h.tasks).toHaveLength(1);
    release();
    await h.settle();
    expect(await runs('demo.slow')).toHaveLength(1);
    // Free again after the release.
    const third = await h.post('demo.slow');
    expect(await third.json()).toEqual({ accepted: true, name: 'demo.slow' });
    release();
    await h.settle();
  });

  test('the job lease lasts ceil(budget/1000) + 30 s', async () => {
    const h = harness({
      'demo.lease': { every: '5 seconds', budgetMs: 10_000, run: async () => ({ items: 0 }) },
    });
    const before = Date.now();
    await h.post('demo.lease');
    const row = await jobRow('demo.lease');
    const secs = (row.lease_until.getTime() - before) / 1000;
    expect(secs).toBeGreaterThan(jobLeaseSeconds(10_000) - 2);
    expect(secs).toBeLessThan(jobLeaseSeconds(10_000) + 2);
    await h.settle();
  });

  test('a throwing job: ok=false with the error in job_runs and sync_state', async () => {
    const h = harness({
      'demo.fail': {
        every: '5 seconds',
        run: async () => {
          throw new Error('vendor said no');
        },
      },
    });
    expect((await h.post('demo.fail')).status).toBe(202);
    await h.settle();
    const rows = await runs('demo.fail');
    expect(rows).toEqual([
      expect.objectContaining({ ok: false, items: null, note: null, error: 'vendor said no' }),
    ]);
    const row = await jobRow('demo.fail');
    expect(row).toMatchObject({ lease_token: null, last_error: 'vendor said no' });
  });

  test('the signal aborts at the deadline (budgetMs)', async () => {
    const h = harness({
      'demo.deadline': {
        every: '5 seconds',
        budgetMs: 1_000,
        run: (ctx) =>
          new Promise<JobResult>((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
          }),
      },
    });
    const started = Date.now();
    await h.post('demo.deadline');
    await h.settle();
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    const [row] = await runs('demo.deadline');
    expect(row).toMatchObject({
      ok: false,
      error: 'job demo.deadline ran past its 1000 ms budget',
    });
  });

  test('a run that outlives its lease still records its row (release reports the loss)', async () => {
    const h = harness({
      'demo.lost': {
        every: '5 seconds',
        run: async () => {
          // Someone else's claim after expiry: simulate by expiring and re-claiming the row.
          await t().pool.query(
            `update ingest.sync_state set lease_until = now() - interval '1 second'
              where source = 'job' and stream = 'demo.lost'`,
          );
          await claimDue(t().pool, JOB_LEASE_SOURCE, 'demo.lost', 60);
          return { items: 1 };
        },
      },
    });
    await h.post('demo.lost');
    await h.settle();
    expect(await runs('demo.lost')).toEqual([expect.objectContaining({ ok: true, items: 1 })]);
    expect((await jobRow('demo.lost')).lease_token).not.toBeNull(); // the other claim stays
  });

  test('host is recorded from the definition', async () => {
    const h = harness({
      'demo.pc': { cron: '40 8 * * *', host: 'pc', run: async () => ({ items: 0 }) },
    });
    await h.post('demo.pc');
    await h.settle();
    expect(await runs('demo.pc')).toEqual([
      expect.objectContaining({ host: 'pc', ok: true, items: 0 }),
    ]);
  });

  test('paused: 202 skipped paused, claims nothing and runs nothing', async () => {
    await setClockPaused(t().db, true);
    let ran = false;
    const h = harness({
      'demo.paused': {
        every: '5 seconds',
        run: async () => {
          ran = true;
          return { items: 0 };
        },
      },
    });
    const res = await h.post('demo.paused');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ skipped: 'paused', name: 'demo.paused' });
    expect(h.tasks).toHaveLength(0);
    expect(ran).toBe(false);
    expect(await jobRow('demo.paused')).toBeUndefined();
  });

  test('a job held by an existing claim elsewhere is busy too', async () => {
    await ensureStream(t().pool, JOB_LEASE_SOURCE, 'demo.held', 'live');
    await claimDue(t().pool, JOB_LEASE_SOURCE, 'demo.held', 60);
    const h = harness({ 'demo.held': { every: '5 seconds', run: async () => ({ items: 0 }) } });
    expect(await (await h.post('demo.held')).json()).toEqual({
      skipped: 'busy',
      name: 'demo.held',
    });
  });
});

describe("app.settings 'clock.paused'", () => {
  let listener: pg.Client;
  const got: NotifyMessage[] = [];
  beforeAll(async () => {
    listener = new pg.Client({ connectionString: t().appUrl });
    await listener.connect();
    listener.on('notification', (n) => {
      if (n.channel === LOCAL_NOTIFY_CHANNEL && n.payload) got.push(JSON.parse(n.payload));
    });
    await listener.query(`listen ${LOCAL_NOTIFY_CHANNEL}`);
  });
  afterAll(async () => {
    await listener?.end();
  });

  test('a missing key reads as not paused', async () => {
    await t().pool.query(`delete from app.settings where key = 'clock.paused'`);
    expect(await readClockPaused(t().pool)).toBe(false);
  });

  test('setClockPaused stores the flag (as farm_app) and publishes admin/clock on commit', async () => {
    got.length = 0;
    await setClockPaused(t().db, true);
    expect(await readClockPaused(t().pool)).toBe(true);
    await setClockPaused(t().db, false);
    expect(await readClockPaused(t().pool)).toBe(false);
    const started = Date.now();
    while (got.filter((m) => m.topic === 'admin').length < 2 && Date.now() - started < 2_000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(got.filter((m) => m.topic === 'admin').map((m) => [m.event, m.payload.paused])).toEqual([
      ['clock', true],
      ['clock', false],
    ]);
  });
});
