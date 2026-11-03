import { describe, expect, test } from 'vitest';
import { farmDate } from './farm';

describe('farmDate', () => {
  test("an instant's calendar date in America/Detroit, across both clock changes", () => {
    // 7 PM EST on Dec 31 is midnight UTC on Jan 1.
    expect(farmDate('2027-01-01T00:00:00Z')).toBe('2026-12-31');
    expect(farmDate('2027-01-01T04:59:59Z')).toBe('2026-12-31');
    expect(farmDate('2027-01-01T05:00:00Z')).toBe('2027-01-01');
    // EDT (UTC-4) from 2027-03-14 02:00 local, EST again from 2027-11-07 02:00 local.
    expect(farmDate('2027-03-15T03:59:59Z')).toBe('2027-03-14');
    expect(farmDate('2027-03-15T04:00:00Z')).toBe('2027-03-15');
    expect(farmDate('2027-11-08T04:59:59Z')).toBe('2027-11-07');
    expect(farmDate('2027-11-08T05:00:00Z')).toBe('2027-11-08');
  });

  test('takes a Date, epoch ms or an ISO string', () => {
    const ms = Date.parse('2026-10-29T14:00:00Z');
    expect(farmDate(ms)).toBe('2026-10-29');
    expect(farmDate(new Date(ms))).toBe('2026-10-29');
    expect(farmDate('2026-10-29T14:00:00.000Z')).toBe('2026-10-29');
  });
});
