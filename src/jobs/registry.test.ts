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
    ]);
  });

  test('demo cadence (JOBS_DEMO_CADENCE=on): trucks every 5 s, Deere every 15 s', () => {
    const valid = validateRegistry(registry);
    expect(valid.map((j) => [j.name, j.demoSchedule])).toEqual([
      ['fleet.trucks', { kind: 'every', seconds: 5 }],
      ['fleet.deere', { kind: 'every', seconds: 15 }],
      ['weather.nws', { kind: 'every', seconds: 30 }],
    ]);
  });

  test('fleet.trucks runs never overlap and its stream lease outlives its budget', () => {
    expect(jobs['fleet.trucks'].budgetMs).toBe(TRUCKS_BUDGET_MS);
    expect(TRUCKS_BUDGET_MS).toBeLessThan(30_000);
    expect(TRUCKS_LEASE_SECONDS * 1000).toBeGreaterThan(TRUCKS_BUDGET_MS);
    expect(jobLeaseSeconds(TRUCKS_BUDGET_MS)).toBeLessThanOrEqual(60);
  });
});
