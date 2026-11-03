import { describe, expect, test } from 'vitest';
import { callsPerDay, operationsShare } from '../connectors/deere/call-shares';
import { type CallsPerRun, callsPerRunOfExtra, nextCallsPerRun } from '../db/queries/api-calls';
import {
  DEERE_OPS_CRON_SECONDS,
  FLEET_DEERE_CRON_SECONDS,
  type OpsCapInputs,
  opsFieldCap,
} from './deere-ops-budget';
import { jobs } from './registry';

/** Seconds between runs of an every-n-minutes cron ('*' + '/n * * * *'). */
function cronIntervalSeconds(cron: string): number {
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
  return m ? Number(m[1]) * 60 : Number.NaN;
}

const base: OpsCapInputs = {
  budget: 1000,
  mode: 'sandbox' as const,
  lastDay: {},
  locationsCallsPerRun: 1,
  // A run that listed both crop seasons of the sync window (D23), as runs do now: 10 calls for
  // 40 fields.
  runs: [{ calls: 10, fields: 40, seasons: 2 }],
  callsPerRun: 10,
  fieldsPerRun: 40,
  seasonsPerField: 2,
};
/** Runs a day at deere.ops' cron. */
const RUNS_A_DAY = 86_400 / DEERE_OPS_CRON_SECONDS;

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
    expect(opsFieldCap({ ...base, runs: [{ calls: 1000, fields: 1, seasons: 2 }] })).toBe(1);
    // Calls per field from the same runs: Σ calls ÷ Σ fields (10 + 30) / (40 + 40) = 0.5.
    expect(
      opsFieldCap({
        ...base,
        runs: [
          { calls: 10, fields: 40, seasons: 2 },
          { calls: 30, fields: 40, seasons: 2 },
        ],
      }),
    ).toBe(2);
    // Live counts like sandbox.
    expect(opsFieldCap({ ...base, mode: 'live' })).toBe(4);
  });

  test('two seasons a field (D23): a one-season measurement counts double, so the day still holds', () => {
    // Measured before D23 (no runs kept; mean calls and the last run's fields, one listing a
    // field), the run now lists two: calls per field 10 / 40 × 2 = 0.5 →
    // floor(100 / (96 × 0.5)) = 2 fields, half of what one season gets.
    const before = { ...base, runs: [] };
    expect(opsFieldCap(before)).toBe(2);
    expect(opsFieldCap({ ...before, budget: 10_000 })).toBe(151);
    // A kept run that listed one season counts double the same way.
    expect(opsFieldCap({ ...base, runs: [{ calls: 10, fields: 40, seasons: 1 }] })).toBe(2);
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

  test.each([300, 1000])(
    'after the change to two seasons the cap settles at half and the day holds (%i fields)',
    (fieldCount) => {
      // Sandbox, DEERE_DAILY_CALL_BUDGET 20 000, fleet.deere 8 calls a run at its 2-min cron
      // (5 760 a day): operations get 16 000 − 5 760 = 10 240 a day (106.7 a run). deere.ops
      // spends 2 calls a run on the org and field listings, and a listing per season per field
      // (no new operations). Before D23 (one season) the cap had settled at 104 fields (106
      // calls a run, 10 176 a day): ten such runs measured, the last one checked 104 fields.
      const budget = 20_000;
      const locationsCallsPerRun = 8;
      const share = operationsShare(
        budget,
        {},
        callsPerDay(locationsCallsPerRun, FLEET_DEERE_CRON_SECONDS),
      );
      expect(share).toBe(10_240);
      let m: CallsPerRun = callsPerRunOfExtra({});
      for (let i = 0; i < 10; i++) m = nextCallsPerRun(m, 'sandbox', 2 + 104);
      let fieldsPerRun = 104;
      const caps: number[] = [];
      const daySpend: number[] = [];
      let today = 0;
      // Four days of runs at two seasons a field, each run measured as sync-health keeps it.
      for (let run = 0; run < 4 * RUNS_A_DAY; run++) {
        const cap = opsFieldCap({
          budget,
          mode: 'sandbox',
          lastDay: {},
          locationsCallsPerRun,
          runs: m.runs.map((r) => ({
            calls: r.calls,
            fields: r.fields ?? 0,
            seasons: r.seasons ?? 1,
          })),
          callsPerRun: m.callsPerRun,
          fieldsPerRun,
          seasonsPerField: 2,
        });
        const fields = Math.min(cap ?? fieldCount, fieldCount);
        const calls = 2 + 2 * fields;
        caps.push(fields);
        today += calls;
        if ((run + 1) % RUNS_A_DAY === 0) {
          daySpend.push(today);
          today = 0;
        }
        m = nextCallsPerRun(m, 'sandbox', calls, { fields, seasons: 2 });
        fieldsPerRun = fields;
      }
      // Half the fields a run from the first run on, every run (not 52, 26, 13 … 1 and then a
      // swing past the share), and every day within the operations share.
      expect(new Set(caps)).toEqual(new Set([52]));
      expect(daySpend).toEqual([10_176, 10_176, 10_176, 10_176]);
      for (const d of daySpend) {
        expect(d).toBeLessThanOrEqual(share);
        // With locations at their cron, the Deere day stays within 80 % of the budget.
        expect(d + callsPerDay(locationsCallsPerRun, FLEET_DEERE_CRON_SECONDS)).toBeLessThanOrEqual(
          0.8 * budget,
        );
      }
    },
  );

  test('no cap without a budget, outside sandbox/live, or before anything is measured', () => {
    expect(opsFieldCap({ ...base, budget: null })).toBeNull();
    expect(opsFieldCap({ ...base, budget: undefined })).toBeNull();
    expect(opsFieldCap({ ...base, mode: 'sim' })).toBeNull();
    expect(opsFieldCap({ ...base, mode: 'replay' })).toBeNull();
    expect(opsFieldCap({ ...base, runs: [], callsPerRun: null })).toBeNull();
    expect(opsFieldCap({ ...base, runs: [], fieldsPerRun: null })).toBeNull();
    // Kept runs that checked no field measure nothing a field (the legacy numbers then count).
    expect(opsFieldCap({ ...base, runs: [{ calls: 3, fields: 0, seasons: 2 }] })).toBe(2);
    // Locations not measured yet count as nothing (not as a reason to stop).
    expect(opsFieldCap({ ...base, locationsCallsPerRun: null })).toBe(33);
  });

  test("the cron intervals it plans with are the registry's", () => {
    expect(cronIntervalSeconds(jobs['fleet.deere'].cron)).toBe(FLEET_DEERE_CRON_SECONDS);
    expect(cronIntervalSeconds(jobs['deere.ops'].cron)).toBe(DEERE_OPS_CRON_SECONDS);
  });
});
