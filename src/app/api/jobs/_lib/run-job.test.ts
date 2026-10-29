import type pg from 'pg';
import { describe, expect, test, vi } from 'vitest';
import type { Db } from '../../../../db/client';
import type { Executor } from '../../../../db/exec';
import type { JobRegistry } from '../../../../jobs/types';
import { createJobLogger } from './logger';
import { bearerMatches, errorText, handleJobPost, type JobRouteDeps } from './run-job';

const SECRET = 's'.repeat(64);

/** A pool that fails the test if the route touches the database. */
const untouchable = {
  query: () => {
    throw new Error('the database must not be touched');
  },
} as unknown as Executor;

function deps(registry: JobRegistry, schedule = vi.fn()): JobRouteDeps {
  return {
    registry,
    secret: SECRET,
    pool: untouchable,
    jobsPool: untouchable as unknown as pg.Pool,
    jobsDb: {} as Db,
    schedule,
  };
}

const post = (auth?: string) =>
  new Request('http://x/api/jobs/demo.job', {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
  });

const registry: JobRegistry = {
  'demo.job': { every: '5 seconds', run: async () => ({ items: 1 }) },
};

describe('bearerMatches', () => {
  test.each([
    [`Bearer ${SECRET}`, true],
    [`bearer ${SECRET}`, true],
    [`Bearer   ${SECRET}  `, true],
    [`Bearer ${SECRET}x`, false],
    [`Bearer ${SECRET.slice(1)}`, false],
    [SECRET, false],
    ['Bearer ', false],
    ['', false],
  ])('%j -> %s', (header, ok) => {
    expect(bearerMatches(header, SECRET)).toBe(ok);
  });

  test('null header or empty secret never match', () => {
    expect(bearerMatches(null, SECRET)).toBe(false);
    expect(bearerMatches('Bearer ', '')).toBe(false);
  });
});

describe('handleJobPost before the database', () => {
  test('no or bad secret: 401 with WWW-Authenticate, nothing scheduled', async () => {
    const schedule = vi.fn();
    for (const auth of [undefined, 'Bearer nope', `Basic ${SECRET}`]) {
      const res = await handleJobPost(post(auth), 'demo.job', deps(registry, schedule));
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    expect(schedule).not.toHaveBeenCalled();
  });

  test('a bad secret is 401 even for an unknown job (no job-name probing)', async () => {
    const res = await handleJobPost(post('Bearer nope'), 'no.such', deps(registry));
    expect(res.status).toBe(401);
  });

  test('unknown job: 404, also for inherited object keys', async () => {
    for (const name of ['no.such', 'constructor', 'toString', '__proto__']) {
      const res = await handleJobPost(post(`Bearer ${SECRET}`), name, deps(registry));
      expect(res.status).toBe(404);
    }
  });

  test('an invalid definition is a 500 with the validator message', async () => {
    const bad = {
      'demo.job': { every: '90 seconds', run: async () => ({ items: 0 }) },
    } as unknown as JobRegistry;
    const res = await handleJobPost(post(`Bearer ${SECRET}`), 'demo.job', deps(bad));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/1 seconds/);
  });

  test('a database error before the claim is a 503 (the clock retries next tick)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handleJobPost(post(`Bearer ${SECRET}`), 'demo.job', deps(registry));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    spy.mockRestore();
  });
});

describe('helpers', () => {
  test('errorText keeps messages short', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('plain')).toBe('plain');
    expect(errorText(new Error('x'.repeat(5_000))).length).toBe(2_000);
  });

  test('the job logger prefixes the job name and honors the level', () => {
    const lines: string[] = [];
    const sink = {
      log: (l: string) => lines.push(`log ${l}`),
      warn: (l: string) => lines.push(`warn ${l}`),
      error: (l: string) => lines.push(`error ${l}`),
    };
    const log = createJobLogger('fleet.trucks', 'info', sink);
    log.debug('hidden');
    log.info('hello', { n: 1 });
    log.warn('careful');
    log.error('bad');
    expect(lines).toEqual([
      'log [job fleet.trucks] hello {"n":1}',
      'warn [job fleet.trucks] careful',
      'error [job fleet.trucks] bad',
    ]);
  });
});
