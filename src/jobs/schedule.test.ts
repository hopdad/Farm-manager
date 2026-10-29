import { describe, expect, test } from 'vitest';
import {
  clockSchedule,
  demoCadenceApplies,
  nextRun,
  parseEvery,
  ScheduleError,
  toPgCronSchedule,
  validateCron,
  validateJobDef,
  validateRegistry,
} from './schedule';
import type { JobDef, JobRegistry } from './types';

const run = async () => ({ items: 0 });

describe('every', () => {
  test.each([1, 5, 30, 59])('accepts %i seconds', (n) => {
    expect(parseEvery(`${n} seconds`)).toBe(n);
  });

  test.each([
    '0 seconds',
    '60 seconds',
    '90 seconds',
    '1 second',
    '30s',
    '1 minute',
    ' 30 seconds',
    '05 seconds',
  ])('rejects %j', (spec) => {
    expect(() => parseEvery(spec)).toThrow(ScheduleError);
  });
});

describe('cron', () => {
  test.each([
    '*/2 * * * *',
    '17 * * * *',
    '40 8 * * *',
    '10 11 * * 1',
    '0 0 1,15 * *',
    '0-30/5 6-18 * * 1-5',
  ])('accepts %j', (expr) => {
    expect(validateCron(expr)).toBe(expr);
  });

  test.each([
    ['* * * *', /exactly 5 fields/],
    ['0 * * * * *', /exactly 5 fields/],
    ['0 8 * * MON', /may only use digits/],
    ['0 8 L * *', /may only use digits/],
    ['@hourly', /exactly 5 fields/],
    ['61 * * * *', /cron/],
    ['0 25 * * *', /cron/],
  ])('rejects %j', (expr, why) => {
    expect(() => validateCron(expr)).toThrow(why);
  });

  test('normalizes whitespace', () => {
    expect(validateCron('  */15   *  * * * ')).toBe('*/15 * * * *');
  });
});

describe('job definitions', () => {
  test('every job', () => {
    const v = validateJobDef('fleet.trucks', { every: '30 seconds', run });
    expect(v).toMatchObject({
      schedule: { kind: 'every', seconds: 30 },
      host: 'app',
      budgetMs: 45_000,
    });
  });

  test('cron job on the shop PC', () => {
    const v = validateJobDef('gis.derived', { cron: '40 8 * * *', host: 'pc', run });
    expect(v.schedule).toEqual({ kind: 'cron', expr: '40 8 * * *' });
    expect(v.host).toBe('pc');
  });

  test('demoEvery: an optional local demo cadence, validated like every', () => {
    const v = validateJobDef('fleet.trucks', { every: '30 seconds', demoEvery: '5 seconds', run });
    expect(v.demoSchedule).toEqual({ kind: 'every', seconds: 5 });
    expect(clockSchedule(v, false)).toEqual({ kind: 'every', seconds: 30 });
    expect(clockSchedule(v, true)).toEqual({ kind: 'every', seconds: 5 });
    const c = validateJobDef('fleet.deere', { cron: '*/2 * * * *', run });
    expect(c.demoSchedule).toBeNull();
    expect(clockSchedule(c, true)).toEqual({ kind: 'cron', expr: '*/2 * * * *' });
    expect(() =>
      validateJobDef('a.b', { cron: '* * * * *', demoEvery: '90 seconds' as '1 seconds', run }),
    ).toThrow(/job 'a.b': demoEvery: every '90 seconds' is invalid/);
  });

  test('the demo cadence never applies to a job whose connector talks to a real vendor', () => {
    const w = validateJobDef('weather.nws', {
      cron: '*/30 * * * *',
      demoEvery: '30 seconds',
      connector: 'CONNECTOR_WEATHER',
      run,
    });
    const demo = { kind: 'every', seconds: 30 };
    const real = { kind: 'cron', expr: '*/30 * * * *' };
    for (const mode of ['sim', 'replay', 'off'] as const) {
      expect(demoCadenceApplies(w, true, { CONNECTOR_WEATHER: mode })).toBe(true);
      expect(clockSchedule(w, true, { CONNECTOR_WEATHER: mode })).toEqual(demo);
    }
    for (const mode of ['sandbox', 'live'] as const) {
      expect(demoCadenceApplies(w, true, { CONNECTOR_WEATHER: mode })).toBe(false);
      expect(clockSchedule(w, true, { CONNECTOR_WEATHER: mode })).toEqual(real);
    }
    // Other connectors don't matter; no modes given means the sim default.
    expect(clockSchedule(w, true, { CONNECTOR_DEERE: 'live' })).toEqual(demo);
    expect(clockSchedule(w, true)).toEqual(demo);
    expect(clockSchedule(w, false, { CONNECTOR_WEATHER: 'sim' })).toEqual(real);
  });

  test('needs exactly one schedule', () => {
    expect(() => validateJobDef('a.b', { run } as unknown as JobDef)).toThrow(/exactly one/);
    expect(() =>
      validateJobDef('a.b', { every: '5 seconds', cron: '* * * * *', run } as unknown as JobDef),
    ).toThrow(/exactly one/);
  });

  test('rejects bad names, hosts and budgets', () => {
    expect(() => validateJobDef('Fleet Trucks', { every: '5 seconds', run })).toThrow(/name/);
    expect(() => validateJobDef('a.b', { every: '5 seconds', host: 'edge' as 'app', run })).toThrow(
      /host/,
    );
    expect(() => validateJobDef('a.b', { every: '5 seconds', budgetMs: 120_000, run })).toThrow(
      /budgetMs/,
    );
  });

  test('registry errors are reported together', () => {
    const reg: JobRegistry = {
      'fleet.trucks': { every: '30 seconds', run },
      'weather.nws': { cron: '*/30 * * * *', run },
      'bad.every': { every: '90 seconds', run },
      'bad.cron': { cron: '0 8 * * MON', run },
    };
    expect(() => validateRegistry(reg)).toThrow(/bad\.every|90 seconds[\s\S]*MON/);
    const ok = validateRegistry({ 'fleet.trucks': reg['fleet.trucks'] as JobDef });
    expect(ok.map((j) => j.name)).toEqual(['fleet.trucks']);
  });
});

describe('next runs (UTC) and pg_cron text', () => {
  test('every aligns to multiples of the interval', () => {
    const s = { kind: 'every', seconds: 30 } as const;
    expect(nextRun(s, new Date('2026-10-28T15:00:10Z')).toISOString()).toBe(
      '2026-10-28T15:00:30.000Z',
    );
    expect(nextRun(s, new Date('2026-10-28T15:00:30Z')).toISOString()).toBe(
      '2026-10-28T15:01:00.000Z',
    );
  });

  test('cron runs in UTC', () => {
    const s = { kind: 'cron', expr: '40 8 * * *' } as const;
    expect(nextRun(s, new Date('2026-10-28T09:00:00Z')).toISOString()).toBe(
      '2026-10-29T08:40:00.000Z',
    );
  });

  test('pg_cron schedule text', () => {
    expect(toPgCronSchedule({ kind: 'every', seconds: 30 })).toBe('30 seconds');
    expect(toPgCronSchedule({ kind: 'cron', expr: '*/2 * * * *' })).toBe('*/2 * * * *');
  });
});
