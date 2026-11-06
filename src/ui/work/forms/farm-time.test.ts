/**
 * The job form's farm clock: a datetime-local value is America/Detroit wall time whatever the
 * device's own zone, both ways, across both daylight-saving changes.
 */
import { describe, expect, test } from 'vitest';
import { dateToFarmLocal, farmLocalToDate, farmOffsetMinutes, toFarmIso } from './farm-time';

describe('farm time', () => {
  test('winter and summer offsets', () => {
    expect(farmOffsetMinutes(Date.parse('2026-01-15T12:00:00Z'))).toBe(-300);
    expect(farmOffsetMinutes(Date.parse('2026-07-15T12:00:00Z'))).toBe(-240);
  });

  test('a wall time becomes its instant and back', () => {
    expect(farmLocalToDate('2026-11-09T08:00')?.toISOString()).toBe('2026-11-09T13:00:00.000Z');
    expect(farmLocalToDate('2026-07-01T08:30')?.toISOString()).toBe('2026-07-01T12:30:00.000Z');
    expect(dateToFarmLocal('2026-11-09T13:00:00.000Z')).toBe('2026-11-09T08:00');
    expect(dateToFarmLocal(new Date('2026-07-01T03:59:00Z'))).toBe('2026-06-30T23:59');
    expect(toFarmIso(new Date('2026-11-09T13:00:00Z'))).toBe('2026-11-09T08:00:00-05:00');
    expect(toFarmIso(new Date('2026-07-01T12:30:00Z'))).toBe('2026-07-01T08:30:00-04:00');
  });

  test('daylight saving: the spring gap moves forward, the fall hour takes EDT', () => {
    // 2026-03-08 02:30 does not exist in Detroit.
    expect(farmLocalToDate('2026-03-08T02:30')?.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(dateToFarmLocal('2026-03-08T07:30:00.000Z')).toBe('2026-03-08T03:30');
    // 2026-11-01 01:30 happens twice; the first (EDT, -4) wins.
    expect(farmLocalToDate('2026-11-01T01:30')?.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(farmLocalToDate('2026-11-01T03:00')?.toISOString()).toBe('2026-11-01T08:00:00.000Z');
  });

  test('not a wall time', () => {
    for (const bad of ['', '2026-11-09', '2026-13-01T08:00', '2026-02-30T08:00', '08:00', 'x']) {
      expect(farmLocalToDate(bad), bad).toBeNull();
    }
  });
});
