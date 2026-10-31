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
    expect(m).toEqual({ callsPerRun: null, mode: null, recent: [] });
    m = nextCallsPerRun(m, 'sim', 7);
    m = nextCallsPerRun(m, 'sim', 8);
    expect(m).toEqual({ callsPerRun: 7.5, mode: 'sim', recent: [7, 8] });
    for (let i = 0; i < 20; i++) m = nextCallsPerRun(m, 'sim', 10);
    expect(m.recent).toHaveLength(CALLS_PER_RUN_WINDOW);
    expect(m.callsPerRun).toBe(10);
    m = nextCallsPerRun(m, 'sandbox', 4);
    expect(m).toEqual({ callsPerRun: 4, mode: 'sandbox', recent: [4] });
  });

  test('malformed extra reads as nothing measured', () => {
    expect(callsPerRunOfExtra(null)).toEqual({ callsPerRun: null, mode: null, recent: [] });
    expect(
      callsPerRunOfExtra({ callsPerRun: 'x', callsPerRunMode: 3, callsRecent: [1, 'a', -1, 2] }),
    ).toEqual({ callsPerRun: null, mode: null, recent: [1, 2] });
  });

  test('isCountedMode', () => {
    expect(['sim', 'replay', 'sandbox', 'live'].every(isCountedMode)).toBe(true);
    expect(isCountedMode('off')).toBe(false);
    expect(isCountedMode(null)).toBe(false);
  });
});
