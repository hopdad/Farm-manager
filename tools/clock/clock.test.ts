import { afterEach, describe, expect, test, vi } from 'vitest';
import { type ValidJob, validateRegistry } from '../../src/jobs/schedule';
import type { JobRegistry } from '../../src/jobs/types';
import { describeSchedule, everyDue, type FireOutcome, JobClock, jobUrl } from './clock';
import { ClockUsageError, clockBaseUrl, parseClockArgs, selectJobs } from './index';

const run = async () => ({ items: 0 });
const reg: JobRegistry = {
  'fleet.trucks': { every: '2 seconds', run },
  'fleet.deere': { cron: '* * * * *', run },
  'gis.derived': { cron: '40 8 * * *', host: 'pc', run },
};
const SECRET = 'c'.repeat(64);

function job(name: string): ValidJob {
  const j = validateRegistry(reg).find((v) => v.name === name);
  if (!j) throw new Error(name);
  return j;
}

const quietLog = () => {
  const lines: string[] = [];
  return {
    lines,
    log: {
      debug: () => {},
      info: (m: string) => lines.push(`info ${m}`),
      warn: (m: string) => lines.push(`warn ${m}`),
      error: (m: string) => lines.push(`error ${m}`),
    },
  };
};

function fakeFetch(status = 202, body: unknown = { accepted: true }) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('helpers', () => {
  test('every-jobs fire on epoch-aligned multiples', () => {
    expect(everyDue(1_700_000_010, 5)).toBe(true);
    expect(everyDue(1_700_000_011, 5)).toBe(false);
    expect(everyDue(1_700_000_045, 45)).toBe(false);
    expect(everyDue(1_700_000_010, 45)).toBe(true); // 1_700_000_010 = 45 * 37_777_778
  });

  test('jobUrl and describeSchedule', () => {
    expect(jobUrl('http://127.0.0.1:3000/', 'fleet.trucks')).toBe(
      'http://127.0.0.1:3000/api/jobs/fleet.trucks',
    );
    expect(describeSchedule(job('fleet.trucks'))).toBe('every 2 s');
    expect(describeSchedule(job('gis.derived'))).toBe('cron 40 8 * * * (UTC)');
  });

  test('clockBaseUrl uses IPv4 loopback for localhost', () => {
    expect(clockBaseUrl('http://localhost:3104')).toBe('http://127.0.0.1:3104');
    expect(clockBaseUrl('https://farm.example.com/x')).toBe('https://farm.example.com');
  });

  test('parseClockArgs', () => {
    expect(parseClockArgs([])).toEqual({ once: false, list: false, help: false });
    expect(
      parseClockArgs(['--url=http://127.0.0.1:3001', '--hosts=pc', '--once', '--parent=42']),
    ).toEqual({
      url: 'http://127.0.0.1:3001',
      hosts: ['pc'],
      once: true,
      list: false,
      parent: 42,
      help: false,
    });
    expect(() => parseClockArgs(['--hosts=cloud'])).toThrow(ClockUsageError);
    expect(() => parseClockArgs(['--url=nope'])).toThrow(ClockUsageError);
    expect(() => parseClockArgs(['--bogus'])).toThrow(/unknown argument/);
  });
});

describe('selectJobs (the shared schedule validator)', () => {
  test('filters by host', () => {
    expect(selectJobs(reg, ['app']).map((j) => j.name)).toEqual(['fleet.trucks', 'fleet.deere']);
    expect(selectJobs(reg, ['pc']).map((j) => j.name)).toEqual(['gis.derived']);
    expect(selectJobs(reg, ['app', 'pc'])).toHaveLength(3);
  });

  test('JOBS_DEMO_CADENCE: demoEvery replaces the schedule only when asked', () => {
    const demoReg: JobRegistry = {
      'fleet.trucks': { every: '30 seconds', demoEvery: '5 seconds', run },
      'fleet.deere': { cron: '*/2 * * * *', demoEvery: '15 seconds', run },
      'gis.derived': { cron: '40 8 * * *', host: 'pc', run },
    };
    const sched = (demo: boolean) =>
      selectJobs(demoReg, ['app', 'pc'], { demo }).map((j) => [j.name, describeSchedule(j)]);
    expect(sched(false)).toEqual([
      ['fleet.trucks', 'every 30 s'],
      ['fleet.deere', 'cron */2 * * * * (UTC)'],
      ['gis.derived', 'cron 40 8 * * * (UTC)'],
    ]);
    expect(sched(true)).toEqual([
      ['fleet.trucks', 'every 5 s'],
      ['fleet.deere', 'every 15 s'],
      ['gis.derived', 'cron 40 8 * * * (UTC)'],
    ]);
  });

  test('JOBS_DEMO_CADENCE leaves jobs of a live connector on their real schedule', () => {
    const reg: JobRegistry = {
      'fleet.trucks': {
        every: '30 seconds',
        demoEvery: '5 seconds',
        connector: 'CONNECTOR_ELD',
        run,
      },
      'weather.nws': {
        cron: '*/30 * * * *',
        demoEvery: '30 seconds',
        connector: 'CONNECTOR_WEATHER',
        run,
      },
    };
    const jobs = selectJobs(reg, ['app'], {
      demo: true,
      modes: { CONNECTOR_ELD: 'sim', CONNECTOR_WEATHER: 'live' },
    });
    expect(jobs.map((j) => [j.name, describeSchedule(j)])).toEqual([
      ['fleet.trucks', 'every 5 s'],
      ['weather.nws', 'cron */30 * * * * (UTC)'],
    ]);
  });

  test('refuses an invalid registry, listing every problem', () => {
    const bad = {
      'a.b': { every: '60 seconds', run },
      'c.d': { cron: '0 0 * * * *', run },
      Bad: { every: '5 seconds', run },
    } as unknown as JobRegistry;
    expect(() => selectJobs(bad, ['app'])).toThrow(
      /60 seconds[\s\S]*5 fields[\s\S]*dotted lower-case/,
    );
  });
});

describe('JobClock.fire', () => {
  test('POSTs the job URL with the bearer secret and never follows redirects', async () => {
    const f = fakeFetch();
    const clock = new JobClock({
      jobs: [job('fleet.trucks')],
      baseUrl: 'http://127.0.0.1:3104',
      secret: SECRET,
      isPaused: async () => false,
      fetch: f as unknown as typeof fetch,
      log: quietLog().log,
    });
    expect(await clock.fire(job('fleet.trucks'))).toEqual({ kind: 'accepted' });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3104/api/jobs/fleet.trucks');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test('honors clock.paused: no request while paused; logs the change once', async () => {
    let paused = true;
    const f = fakeFetch();
    const { lines, log } = quietLog();
    let t = 0;
    const clock = new JobClock({
      jobs: [job('fleet.trucks')],
      baseUrl: 'http://x',
      secret: SECRET,
      isPaused: async () => paused,
      fetch: f as unknown as typeof fetch,
      log,
      now: () => t,
    });
    expect(await clock.fire(job('fleet.trucks'))).toEqual({ kind: 'paused' });
    t += 1_000;
    expect(await clock.fire(job('fleet.trucks'))).toEqual({ kind: 'paused' });
    expect(f).not.toHaveBeenCalled();
    paused = false;
    t += 1_000; // the flag is re-read (cache is 500 ms)
    expect(await clock.fire(job('fleet.trucks'))).toEqual({ kind: 'accepted' });
    expect(lines.filter((l) => l.includes('paused'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('resumed'))).toBe(true);
  });

  test('a failing settings read fires anyway (the route decides) and warns once', async () => {
    const f = fakeFetch();
    const { lines, log } = quietLog();
    let t = 0;
    const clock = new JobClock({
      jobs: [],
      baseUrl: 'http://x',
      secret: SECRET,
      isPaused: async () => {
        throw new Error('db down');
      },
      fetch: f as unknown as typeof fetch,
      log,
      now: () => (t += 1_000),
    });
    await clock.fire(job('fleet.trucks'));
    await clock.fire(job('fleet.trucks'));
    expect(f).toHaveBeenCalledTimes(2);
    expect(lines.filter((l) => l.includes('db down'))).toHaveLength(1);
  });

  test('skips a slot while the previous request is in flight', async () => {
    let resolve!: (r: Response) => void;
    const f = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    const clock = new JobClock({
      jobs: [],
      baseUrl: 'http://x',
      secret: SECRET,
      isPaused: async () => false,
      fetch: f as unknown as typeof fetch,
      log: quietLog().log,
    });
    const first = clock.fire(job('fleet.trucks'));
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    expect(await clock.fire(job('fleet.trucks'))).toEqual({ kind: 'in-flight' });
    resolve(new Response(JSON.stringify({ skipped: 'busy' }), { status: 202 }));
    expect(await first).toEqual({ kind: 'skipped', reason: 'busy' });
  });

  test('reports HTTP errors (with a hint for 401) and unreachable apps once per state', async () => {
    const { lines, log } = quietLog();
    let mode: 'unauth' | 'down' = 'unauth';
    const f = vi.fn(async () => {
      if (mode === 'down')
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    });
    let t = 0;
    const clock = new JobClock({
      jobs: [],
      baseUrl: 'http://127.0.0.1:9',
      secret: SECRET,
      isPaused: async () => false,
      fetch: f as unknown as typeof fetch,
      log,
      now: () => (t += 1_000),
    });
    const outcomes: FireOutcome[] = [];
    outcomes.push(await clock.fire(job('fleet.trucks')));
    outcomes.push(await clock.fire(job('fleet.trucks')));
    mode = 'down';
    outcomes.push(await clock.fire(job('fleet.trucks')));
    outcomes.push(await clock.fire(job('fleet.trucks')));
    expect(outcomes.map((o) => o.kind)).toEqual([
      'http-error',
      'http-error',
      'unreachable',
      'unreachable',
    ]);
    expect(lines.filter((l) => l.includes('HTTP 401'))).toHaveLength(1);
    expect(lines.find((l) => l.includes('HTTP 401'))).toMatch(/JOBS_SECRET/);
    expect(lines.filter((l) => l.includes('not reachable'))).toHaveLength(1);
    expect(lines.find((l) => l.includes('not reachable'))).toMatch(/ECONNREFUSED/);
  });
});

describe('JobClock schedules (croner, UTC)', () => {
  test('every-jobs fire on epoch-aligned seconds; cron jobs on their UTC minute; stop() stops', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-29T12:00:57.000Z') });
    const fired: { name: string; at: number }[] = [];
    const f = vi.fn(async (url: string | URL | Request) => {
      fired.push({ name: String(url).split('/').pop() as string, at: Date.now() });
      return new Response('{"accepted":true}', { status: 202 });
    });
    const clock = new JobClock({
      jobs: [job('fleet.trucks'), job('fleet.deere')],
      baseUrl: 'http://x',
      secret: SECRET,
      isPaused: async () => false,
      fetch: f as unknown as typeof fetch,
      log: quietLog().log,
    });
    const next = clock.nextRuns();
    expect(next.map((n) => n.next?.toISOString())).toEqual([
      '2026-10-29T12:00:58.000Z',
      '2026-10-29T12:01:00.000Z',
    ]);
    clock.start();
    await vi.advanceTimersByTimeAsync(6_100);
    clock.stop();
    const trucks = fired
      .filter((x) => x.name === 'fleet.trucks')
      .map((x) => new Date(x.at).getUTCSeconds());
    expect(trucks).toEqual([58, 0, 2]);
    const deere = fired
      .filter((x) => x.name === 'fleet.deere')
      .map((x) => new Date(x.at).toISOString());
    expect(deere).toHaveLength(1);
    expect(deere[0]).toMatch(/T12:01:00/);
    const before = fired.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fired.length).toBe(before);
  });
});
