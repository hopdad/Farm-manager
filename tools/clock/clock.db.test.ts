/**
 * The local scheduling loop on a real database: JobClock (croner, UTC) -> POST /api/jobs/<name>
 * over HTTP -> handleJobPost (secret, lease, 202) -> the after() work -> ingest.job_runs.
 * Pausing (app.settings 'clock.paused', re-read before each fire) stops the posts; resuming
 * starts them again.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { handleJobPost } from '../../src/app/api/jobs/_lib/run-job';
import { readClockPaused, setClockPaused } from '../../src/db/settings';
import type { JobRegistry } from '../../src/jobs/types';
import { setupTestDb } from '../../src/test/db';
import { JobClock } from './clock';
import { selectJobs } from './index';

const t = setupTestDb(import.meta.url);
const SECRET = 'k'.repeat(64);
let ran = 0;
const registry: JobRegistry = {
  'demo.tick': {
    every: '1 seconds',
    budgetMs: 1_000,
    run: async () => {
      ran++;
      return { items: 1 };
    },
  },
  'demo.pc': { cron: '0 0 1 1 *', host: 'pc', run: async () => ({ items: 0 }) },
};

let server: http.Server;
let base = '';
const posts: string[] = [];

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const name = decodeURIComponent((req.url ?? '').replace(/^\/api\/jobs\//, ''));
    posts.push(name);
    const pending: (() => Promise<void>)[] = [];
    const response = await handleJobPost(
      new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: { authorization: String(req.headers.authorization ?? '') },
      }),
      name,
      {
        registry,
        secret: SECRET,
        pool: t().pool,
        jobsPool: t().pool,
        jobsDb: t().db,
        schedule: (task) => {
          pending.push(task);
        },
        logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
      },
    );
    res.writeHead(response.status, { 'content-type': 'application/json' });
    res.end(await response.text());
    // Like after(): the work runs once the response is sent.
    for (const task of pending) await task();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runCount(): Promise<number> {
  const r = await t().pool.query(
    `select count(*)::int as n from ingest.job_runs where job = 'demo.tick' and ok`,
  );
  return r.rows[0].n as number;
}

describe('clock -> /api/jobs -> job_runs', () => {
  test('fires every second, records runs, honors clock.paused, and skips other hosts', async () => {
    const clock = new JobClock({
      jobs: selectJobs(registry, ['app']),
      baseUrl: base,
      secret: SECRET,
      isPaused: () => readClockPaused(t().pool),
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    clock.start();
    try {
      await sleep(3_200);
      const running = await runCount();
      expect(running).toBeGreaterThanOrEqual(2);
      expect(ran).toBe(running);
      expect(posts.every((p) => p === 'demo.tick')).toBe(true);

      await setClockPaused(t().db, true);
      await sleep(1_100); // a fire in flight may still land
      const atPause = posts.length;
      await sleep(2_200);
      expect(posts.length).toBe(atPause);

      await setClockPaused(t().db, false);
      await sleep(2_200);
      expect(posts.length).toBeGreaterThan(atPause);
      expect(await runCount()).toBeGreaterThan(running);
    } finally {
      clock.stop();
      await setClockPaused(t().db, false);
    }
  }, 20_000);
});
