import { describe, expect, test } from 'vitest';
import { DEERE_OPS_CRON_SECONDS, FLEET_DEERE_CRON_SECONDS, opsFieldCap } from './deere-ops-budget';
import { jobs } from './registry';

/** Seconds between runs of an every-n-minutes cron ('*' + '/n * * * *'). */
function cronIntervalSeconds(cron: string): number {
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
  return m ? Number(m[1]) * 60 : Number.NaN;
}

const base = {
  budget: 1000,
  mode: 'sandbox' as const,
  lastDay: {},
  locationsCallsPerRun: 1,
  callsPerRun: 10,
  fieldsPerRun: 40,
  // Measured on runs that listed both crop seasons of the sync window (D23), as runs do now.
  seasonsPerField: 2,
  seasonsMeasured: 2,
};

describe('opsFieldCap (decision 4)', () => {
  test('operations get what is left after the unpaced streams and locations at full cadence', () => {
    // locations: 1 call every 120 s = 720 a day; share = max(100, 800 − 0 − 720) = 100;
    // calls per field = 10 / 40; runs a day = 96 → floor(100 / 24) = 4.
    expect(opsFieldCap(base)).toBe(4);
    // Unpaced streams spent 500 yesterday: the 10 % floor (100) still holds.
    expect(opsFieldCap({ ...base, lastDay: { fields: 500, flags: 40 } })).toBe(4);
    // A bigger budget: share = 8000 − 720 = 7280 → floor(7280 / 24) = 303.
    expect(opsFieldCap({ ...base, budget: 10_000 })).toBe(303);
    // Never below one field a run.
    expect(opsFieldCap({ ...base, callsPerRun: 1000, fieldsPerRun: 1 })).toBe(1);
    // Live counts like sandbox.
    expect(opsFieldCap({ ...base, mode: 'live' })).toBe(4);
  });

  test('two seasons a field (D23): a one-season measurement counts double, so the day still holds', () => {
    // Measured before D23 (one listing a field), the run now lists two: calls per field
    // 10 / 40 × 2 / 1 = 0.5 → floor(100 / (96 × 0.5)) = 2 fields, half of what one season gets.
    expect(opsFieldCap({ ...base, seasonsMeasured: 1 })).toBe(2);
    expect(opsFieldCap({ ...base, budget: 10_000, seasonsMeasured: 1 })).toBe(151);
    // Measured on two-season runs: the per-field cost already holds both listings.
    expect(opsFieldCap(base)).toBe(4);
    // The day's calls at that cap stay within the operations share (100 here, 7280 with 10 000):
    // runs a day × fields × calls per field at two seasons.
    const perFieldTwoSeasons = (10 / 40) * 2;
    expect(96 * 2 * perFieldTwoSeasons).toBeLessThanOrEqual(100);
    expect(96 * 151 * perFieldTwoSeasons).toBeLessThanOrEqual(7280);
    // A one-season measurement read as if it were two would overspend: 96 × 4 × 0.5 = 192 > 100.
    expect(96 * 4 * perFieldTwoSeasons).toBeGreaterThan(100);
  });

  test('no cap without a budget, outside sandbox/live, or before anything is measured', () => {
    expect(opsFieldCap({ ...base, budget: null })).toBeNull();
    expect(opsFieldCap({ ...base, budget: undefined })).toBeNull();
    expect(opsFieldCap({ ...base, mode: 'sim' })).toBeNull();
    expect(opsFieldCap({ ...base, mode: 'replay' })).toBeNull();
    expect(opsFieldCap({ ...base, callsPerRun: null })).toBeNull();
    expect(opsFieldCap({ ...base, fieldsPerRun: null })).toBeNull();
    // Locations not measured yet count as nothing (not as a reason to stop).
    expect(opsFieldCap({ ...base, locationsCallsPerRun: null })).toBe(33);
  });

  test("the cron intervals it plans with are the registry's", () => {
    expect(cronIntervalSeconds(jobs['fleet.deere'].cron)).toBe(FLEET_DEERE_CRON_SECONDS);
    expect(cronIntervalSeconds(jobs['deere.ops'].cron)).toBe(DEERE_OPS_CRON_SECONDS);
  });
});
