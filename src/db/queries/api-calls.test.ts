/** The calls-per-run measurement kept in sync_state.extra (pure parts). */
import { describe, expect, test } from 'vitest';
import {
  CALLS_PER_RUN_WINDOW,
  callsPerRunOfExtra,
  isCountedMode,
  nextCallsPerRun,
} from './api-calls';

describe('callsPerRun', () => {
  test('a mean of the last runs in one mode; a mode switch starts over', () => {
    let m = callsPerRunOfExtra({});
    expect(m).toEqual({ callsPerRun: null, mode: null, recent: [], runs: [] });
    m = nextCallsPerRun(m, 'sim', 7);
    m = nextCallsPerRun(m, 'sim', 8);
    expect(m).toEqual({ callsPerRun: 7.5, mode: 'sim', recent: [7, 8], runs: [] });
    for (let i = 0; i < 20; i++) m = nextCallsPerRun(m, 'sim', 10);
    expect(m.recent).toHaveLength(CALLS_PER_RUN_WINDOW);
    expect(m.callsPerRun).toBe(10);
    m = nextCallsPerRun(m, 'sandbox', 4);
    expect(m).toEqual({ callsPerRun: 4, mode: 'sandbox', recent: [4], runs: [] });
  });

  test("a run's measures are kept with its own calls (D23), in the same window and mode", () => {
    let m = callsPerRunOfExtra({
      callsPerRun: 106,
      callsPerRunMode: 'sandbox',
      callsRecent: [106],
    });
    m = nextCallsPerRun(m, 'sandbox', 106, { fields: 52, seasons: 2 });
    expect(m).toEqual({
      callsPerRun: 106,
      mode: 'sandbox',
      recent: [106, 106],
      runs: [{ fields: 52, seasons: 2, calls: 106 }],
    });
    // A run without measures counts in the mean only.
    m = nextCallsPerRun(m, 'sandbox', 10);
    expect(m.runs).toEqual([{ fields: 52, seasons: 2, calls: 106 }]);
    for (let i = 0; i < 20; i++) m = nextCallsPerRun(m, 'sandbox', 8, { fields: 3, seasons: 2 });
    expect(m.runs).toHaveLength(CALLS_PER_RUN_WINDOW);
    expect(m.runs.at(-1)).toEqual({ fields: 3, seasons: 2, calls: 8 });
    // A mode switch starts the runs over too.
    m = nextCallsPerRun(m, 'live', 5);
    expect(m.runs).toEqual([]);
    // Read back from extra; malformed entries are dropped.
    expect(
      callsPerRunOfExtra({
        runsRecent: [{ calls: 4, fields: 2, seasons: 2 }, { fields: 2 }, { calls: -1 }, 3, null],
      }).runs,
    ).toEqual([{ calls: 4, fields: 2, seasons: 2 }]);
  });

  test('malformed extra reads as nothing measured', () => {
    expect(callsPerRunOfExtra(null)).toEqual({
      callsPerRun: null,
      mode: null,
      recent: [],
      runs: [],
    });
    expect(
      callsPerRunOfExtra({ callsPerRun: 'x', callsPerRunMode: 3, callsRecent: [1, 'a', -1, 2] }),
    ).toEqual({ callsPerRun: null, mode: null, recent: [1, 2], runs: [] });
  });

  test('isCountedMode', () => {
    expect(['sim', 'replay', 'sandbox', 'live'].every(isCountedMode)).toBe(true);
    expect(isCountedMode('off')).toBe(false);
    expect(isCountedMode(null)).toBe(false);
  });
});
