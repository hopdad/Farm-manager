import { describe, expect, test } from 'vitest';
import { jobLeaseSeconds } from '../db/leases';
import { TRUCKS_BUDGET_MS, TRUCKS_LEASE_SECONDS } from './fleet';
import { jobs, registry } from './registry';
import { validateRegistry } from './schedule';

describe('job registry', () => {
  test('validates with the shared schedule validator', () => {
    const valid = validateRegistry(registry);
    expect(valid.map((j) => [j.name, j.schedule, j.host])).toEqual([
      ['fleet.trucks', { kind: 'every', seconds: 30 }, 'app'],
      ['fleet.deere', { kind: 'cron', expr: '*/2 * * * *' }, 'app'],
      ['weather.nws', { kind: 'cron', expr: '*/30 * * * *' }, 'app'],
      ['deere.fields', { kind: 'cron', expr: '17 * * * *' }, 'app'],
      ['deere.ops', { kind: 'cron', expr: '*/15 * * * *' }, 'app'],
    ]);
  });

  test('demo cadence (JOBS_DEMO_CADENCE=on): trucks 5 s, Deere 15 s, weather 30 s, 1f 45/20 s', () => {
    const valid = validateRegistry(registry);
    expect(valid.map((j) => [j.name, j.demoSchedule])).toEqual([
      ['fleet.trucks', { kind: 'every', seconds: 5 }],
      ['fleet.deere', { kind: 'every', seconds: 15 }],
      ['weather.nws', { kind: 'every', seconds: 30 }],
      ['deere.fields', { kind: 'every', seconds: 45 }],
      ['deere.ops', { kind: 'every', seconds: 20 }],
    ]);
  });

  test('the 1f Deere jobs are registered with stubs until their builders land (clock stays green)', async () => {
    const ctx = {} as Parameters<(typeof jobs)['deere.fields']['run']>[0];
    expect(await jobs['deere.fields'].run(ctx)).toEqual({ items: 0, note: 'not built yet' });
    expect(await jobs['deere.ops'].run(ctx)).toEqual({ items: 0, note: 'not built yet' });
    expect(jobs['deere.fields'].connector).toBe('CONNECTOR_DEERE');
    expect(jobs['deere.ops'].connector).toBe('CONNECTOR_DEERE');
  });

  test('fleet.trucks runs never overlap and its stream lease outlives its budget', () => {
    expect(jobs['fleet.trucks'].budgetMs).toBe(TRUCKS_BUDGET_MS);
    expect(TRUCKS_BUDGET_MS).toBeLessThan(30_000);
    expect(TRUCKS_LEASE_SECONDS * 1000).toBeGreaterThan(TRUCKS_BUDGET_MS);
    expect(jobLeaseSeconds(TRUCKS_BUDGET_MS)).toBeLessThanOrEqual(60);
  });
});
