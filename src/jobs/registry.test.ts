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
      ['fleet.motive', { kind: 'every', seconds: 30 }, 'app'],
      ['fleet.geotab', { kind: 'every', seconds: 30 }, 'app'],
      ['fleet.equipment', { kind: 'cron', expr: '* * * * *' }, 'app'],
      ['fleet.aemp', { kind: 'cron', expr: '*/15 * * * *' }, 'app'],
      ['fleet.cnh', { kind: 'cron', expr: '*/5 * * * *' }, 'app'],
      ['fleet.terminal', { kind: 'cron', expr: '* * * * *' }, 'app'],
      ['fleet.vehicles', { kind: 'cron', expr: '41 * * * *' }, 'app'],
    ]);
  });

  test('demo cadence (JOBS_DEMO_CADENCE=on): trucks 5 s, Deere 15 s, weather 30 s, 1f 45/20 s, 1f.2', () => {
    const valid = validateRegistry(registry);
    expect(valid.map((j) => [j.name, j.demoSchedule])).toEqual([
      ['fleet.trucks', { kind: 'every', seconds: 5 }],
      ['fleet.deere', { kind: 'every', seconds: 15 }],
      ['weather.nws', { kind: 'every', seconds: 30 }],
      ['deere.fields', { kind: 'every', seconds: 45 }],
      ['deere.ops', { kind: 'every', seconds: 20 }],
      ['fleet.motive', { kind: 'every', seconds: 5 }],
      ['fleet.geotab', { kind: 'every', seconds: 10 }],
      ['fleet.equipment', { kind: 'every', seconds: 10 }],
      ['fleet.aemp', { kind: 'every', seconds: 30 }],
      ['fleet.cnh', { kind: 'every', seconds: 30 }],
      ['fleet.terminal', { kind: 'every', seconds: 15 }],
      ['fleet.vehicles', { kind: 'every', seconds: 59 }],
    ]);
  });

  // 1f.2 (docs/contracts-1f.md part B): one job per telematics connection, each on its own mode
  // key; only what stays true when the builders swap their real run functions in.
  test('every telematics connection has its job on its own mode key', () => {
    const connectorOf = Object.fromEntries(
      Object.entries(jobs).map(([name, def]) => [name, (def as { connector?: string }).connector]),
    );
    expect(connectorOf).toEqual({
      'fleet.trucks': 'CONNECTOR_SAMSARA',
      'fleet.deere': 'CONNECTOR_DEERE',
      'weather.nws': 'CONNECTOR_WEATHER',
      'deere.fields': 'CONNECTOR_DEERE',
      'deere.ops': 'CONNECTOR_DEERE',
      'fleet.motive': 'CONNECTOR_MOTIVE',
      'fleet.geotab': 'CONNECTOR_GEOTAB',
      'fleet.equipment': 'CONNECTOR_SAMSARA',
      'fleet.aemp': 'CONNECTOR_AEMP',
      'fleet.cnh': 'CONNECTOR_CNH',
      'fleet.terminal': 'CONNECTOR_TERMINAL',
      'fleet.vehicles': 'CONNECTOR_SAMSARA',
    });
    for (const def of Object.values(jobs)) expect(typeof def.run).toBe('function');
  });

  // Only what stays true when deere-data and deere-ops swap their real run functions in
  // (docs/contracts-1f.md §1.1): registration, connector, schedules, a run function.
  test('the 1f Deere jobs are registered on the Deere connector with their schedules', () => {
    expect(jobs['deere.fields']).toMatchObject({
      cron: '17 * * * *',
      demoEvery: '45 seconds',
      connector: 'CONNECTOR_DEERE',
    });
    expect(jobs['deere.ops']).toMatchObject({
      cron: '*/15 * * * *',
      demoEvery: '20 seconds',
      connector: 'CONNECTOR_DEERE',
    });
    expect(typeof jobs['deere.fields'].run).toBe('function');
    expect(typeof jobs['deere.ops'].run).toBe('function');
  });

  test('fleet.trucks runs never overlap and its stream lease outlives its budget', () => {
    expect(jobs['fleet.trucks'].budgetMs).toBe(TRUCKS_BUDGET_MS);
    expect(TRUCKS_BUDGET_MS).toBeLessThan(30_000);
    expect(TRUCKS_LEASE_SECONDS * 1000).toBeGreaterThan(TRUCKS_BUDGET_MS);
    expect(jobLeaseSeconds(TRUCKS_BUDGET_MS)).toBeLessThanOrEqual(60);
  });
});
