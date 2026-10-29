import { describe, expect, test } from 'vitest';
import { runScenario } from './check';
import { SCENARIO_NAMES } from './types';

describe('sim:scenario checks (headless day, plan §7)', () => {
  for (const scenario of SCENARIO_NAMES) {
    test(`${scenario}: every check passes`, () => {
      const run = runScenario({ scenario, fineStepS: 20, speed: 60 });
      const failed = run.checks.filter((c) => !c.ok);
      expect(failed).toEqual([]);
      expect(run.ok).toBe(true);
      expect(run.checks.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          'samples are valid',
          'counters never go down',
          'everything is parked at night',
          'nobody needed a forced stop',
        ]),
      );
    });
  }

  test('harvest-day reports acres, loads per elevator and the board view', () => {
    const run = runScenario({ scenario: 'harvest-day', fineStepS: 30, speed: 30, pollSeconds: 5 });
    expect(run.summary.acres.harvest).toBeGreaterThan(200);
    expect(run.summary.loads).toBeGreaterThan(30);
    expect(Object.keys(run.summary.loadsByElevator).length).toBeGreaterThanOrEqual(1);
    expect(run.summary.board.pollSimSeconds).toBe(150);
    expect(run.summary.machines.find((m) => m.unitNo === 'S1')?.miles).toBeGreaterThan(30);
    const names = run.checks.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'transport stays on the road graph',
        'no pass outside its field',
        'acres harvested',
        'loads delivered',
      ]),
    );
  });

  test('multi-day runs add up the days', () => {
    const one = runScenario({ scenario: 'harvest-day', fineStepS: 60 });
    const two = runScenario({ scenario: 'harvest-day', fineStepS: 60, days: 2 });
    expect(two.summary.loads).toBeGreaterThan(one.summary.loads);
    expect(two.days).toHaveLength(2);
    expect(two.reports[1]?.dayIndex).toBe(1);
  });
});
