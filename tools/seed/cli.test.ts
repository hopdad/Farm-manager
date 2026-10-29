/**
 * Argument parsing and output of the two CLIs this stage owns: scripts/seed.ts (pnpm db:seed)
 * and scripts/sim-scenario.ts (pnpm sim:scenario). Lives here because tools/seed/** is ours.
 */
import { describe, expect, test } from 'vitest';
import { parseSeedArgs, UsageError as SeedUsageError } from '../../scripts/seed';
import { formatRun, parseSimScenarioArgs, UsageError } from '../../scripts/sim-scenario';
import { assertLocalUrl } from '../../src/db/admin';
import { runScenario } from '../../src/sim/check';

describe('pnpm sim:scenario arguments', () => {
  test('defaults and flags', () => {
    expect(parseSimScenarioArgs(['harvest-day'])).toEqual({
      scenario: 'harvest-day',
      speed: 60,
      poll: 5,
      seed: 1,
      days: 1,
      assert: false,
      json: false,
      wall: false,
    });
    expect(
      parseSimScenarioArgs(
        [
          'breakdown',
          '--speed',
          '30',
          '--poll',
          '2',
          '--seed',
          '7',
          '--days',
          '3',
          '--assert',
          '--json',
        ],
        4,
      ),
    ).toMatchObject({
      scenario: 'breakdown',
      speed: 30,
      poll: 2,
      seed: 7,
      days: 3,
      assert: true,
      json: true,
    });
    expect(parseSimScenarioArgs(['winter-idle'], 9).seed).toBe(9);
  });

  test('rejects bad input with a usage message', () => {
    expect(() => parseSimScenarioArgs([])).toThrow(UsageError);
    expect(() => parseSimScenarioArgs(['harvest-night'])).toThrow(/unknown scenario/);
    expect(() => parseSimScenarioArgs(['harvest-day', '--speed', '0'])).toThrow(/speed/);
    expect(() => parseSimScenarioArgs(['harvest-day', '--speed', 'fast'])).toThrow(/speed/);
    expect(() => parseSimScenarioArgs(['harvest-day', '--seed', '-1'])).toThrow(/seed/);
    expect(() => parseSimScenarioArgs(['harvest-day', '--bogus'])).toThrow(UsageError);
    expect(() => parseSimScenarioArgs(['harvest-day', 'extra'])).toThrow(UsageError);
  });

  test('formats a run as a readable summary', () => {
    const text = formatRun(runScenario({ scenario: 'winter-idle', fineStepS: 300 }));
    expect(text).toMatch(/^winter-idle \(seed 1\)/);
    expect(text).toMatch(/PASS {2}everything is parked at the shop/);
    expect(text).toMatch(/all checks passed$/);
  });
});

describe('pnpm db:seed arguments', () => {
  test('demo with the configured seed, or --seed', () => {
    expect(parseSeedArgs(['demo'], 1)).toEqual({ set: 'demo', seed: 1 });
    expect(parseSeedArgs(['demo', '--seed', '3'], 1)).toEqual({ set: 'demo', seed: 3 });
  });

  test('rejects unknown sets and bad seeds', () => {
    expect(() => parseSeedArgs([], 1)).toThrow(SeedUsageError);
    expect(() => parseSeedArgs(['prod'], 1)).toThrow(/unknown seed set/);
    expect(() => parseSeedArgs(['demo', '--seed', '1.5'], 1)).toThrow(/seed/);
    expect(() => parseSeedArgs(['demo', 'demo'], 1)).toThrow(SeedUsageError);
  });

  test('the seed refuses non-local databases (the guard it calls)', () => {
    expect(() => assertLocalUrl('postgres://u:p@db.example.com:5432/postgres', 'db:seed')).toThrow(
      /refuses non-local/,
    );
    expect(() =>
      assertLocalUrl('postgres://u:p@127.0.0.1:15432/farm_dev_sim', 'db:seed'),
    ).not.toThrow();
  });
});
