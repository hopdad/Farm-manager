/**
 * The Deere call-budget split (1f decision 4, docs/contracts-1f.md §5.5): locations get 80 % of
 * the budget minus what every other Deere stream spent on the last full UTC day (floor 10 %);
 * operations get what is left after the unpaced streams and locations at full cadence.
 */
import { describe, expect, test } from 'vitest';
import {
  callsPerDay,
  DEERE_LOCATIONS_STREAM,
  DEERE_OPERATIONS_STREAM,
  deereCallSplit,
  lastFullUtcDay,
  locationsShare,
  operationsFieldCap,
  operationsShare,
  paceSeconds,
} from './call-shares';

const B = 10_000;

describe('Deere call shares', () => {
  test('the last full UTC day', () => {
    expect(lastFullUtcDay(new Date('2026-10-30T00:00:00Z'))).toBe('2026-10-29');
    expect(lastFullUtcDay(new Date('2026-10-30T23:59:59Z'))).toBe('2026-10-29');
    expect(lastFullUtcDay(new Date('2026-03-01T03:00:00Z'))).toBe('2026-02-28');
  });

  test('locations: 80 % minus every other Deere stream, never under 10 %', () => {
    expect(locationsShare(B, {})).toBe(8_000);
    expect(
      locationsShare(B, { locations: 7_000, operations: 1_500, fields: 300, flags: 200 }),
    ).toBe(6_000);
    // The other streams alone spent the target: locations keep their floor.
    expect(locationsShare(B, { operations: 9_000 })).toBe(1_000);
    // Garbage counts are ignored.
    expect(locationsShare(B, { fields: Number.NaN, flags: -5 })).toBe(8_000);
  });

  test('operations: what is left after the unpaced streams and locations at full cadence', () => {
    // Locations every 2 min at 5 calls = 3 600 a day; yesterday's operations don't count.
    const loc = callsPerDay(5, 120);
    expect(loc).toBe(3_600);
    expect(operationsShare(B, { fields: 300, hours: 100, operations: 5_000 }, loc)).toBe(4_000);
    expect(operationsShare(B, { fields: 300 }, 9_000)).toBe(1_000); // floor
    expect(operationsShare(B, {}, 0)).toBe(8_000);
  });

  test('the two paced shares never plan on the same calls once both are measured', () => {
    const loc = callsPerDay(20, 120); // 14 400 a day at cron: more than the target
    const yesterday = { fields: 400, operations: operationsShare(B, { fields: 400 }, loc) };
    const locations = locationsShare(B, yesterday);
    const operations = operationsShare(B, yesterday, loc);
    expect(operations).toBe(1_000); // floor
    expect(locations + operations + 400).toBeLessThanOrEqual(B);
  });

  test('pace: the interval that keeps a stream within its share; unmeasured = no minimum', () => {
    expect(paceSeconds(10, 7_200)).toBe(120);
    expect(paceSeconds(10, 1_000)).toBe(864);
    expect(paceSeconds(7, 3_000)).toBe(Math.ceil((7 * 86_400) / 3_000));
    expect(paceSeconds(null, 1_000)).toBeNull();
    expect(paceSeconds(0, 1_000)).toBeNull();
  });

  test('operations field cap: at least one field a run; unmeasured = no cap', () => {
    // 96 runs a day (every 15 min), 3 calls a field, 2 880 calls a day → 10 fields a run.
    expect(operationsFieldCap(2_880, 96, 3)).toBe(10);
    expect(operationsFieldCap(10, 96, 3)).toBe(1);
    expect(operationsFieldCap(2_880, 96, null)).toBeNull();
  });

  test('the split /admin/connectors shows, with the warning', () => {
    const split = deereCallSplit(
      B,
      { [DEERE_LOCATIONS_STREAM]: 2_000, [DEERE_OPERATIONS_STREAM]: 6_000, fields: 2_500 },
      callsPerDay(10, 120),
    );
    expect(split).toEqual({
      budget: B,
      target: 8_000,
      lastDay: { locations: 2_000, operations: 6_000, others: 2_500 },
      shares: { locations: 1_000, operations: 1_000 },
      othersOverTarget: true,
    });
    expect(deereCallSplit(B, { fields: 100 }, 0).othersOverTarget).toBe(false);
  });
});
