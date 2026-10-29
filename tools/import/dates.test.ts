import { describe, expect, test } from 'vitest';
import { detroitMidnight, detroitToday, parseDate } from './dates';

describe('parseDate', () => {
  test('ISO and US month/day/year (Excel on Windows)', () => {
    expect(parseDate('2025-05-03')).toEqual({ ok: true, value: '2025-05-03' });
    expect(parseDate(' 2025-5-3 ')).toEqual({ ok: true, value: '2025-05-03' });
    expect(parseDate('5/3/2025')).toEqual({ ok: true, value: '2025-05-03' });
    expect(parseDate('12/31/2024 0:00')).toEqual({ ok: true, value: '2024-12-31' });
    expect(parseDate('2025-05-03T00:00:00Z')).toEqual({ ok: true, value: '2025-05-03' });
  });

  test('refuses impossible, two-digit-year and day-first dates', () => {
    expect(parseDate('2025-02-30').ok).toBe(false);
    expect(parseDate('13/1/2025').ok).toBe(false);
    const short = parseDate('5/3/25');
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.error).toMatch(/year in full/);
    expect(parseDate('May 3').ok).toBe(false);
    expect(parseDate('1850-01-01').ok).toBe(false);
  });
});

describe('Detroit days', () => {
  test('midnight is 05:00 UTC in winter, 04:00 UTC in summer', () => {
    expect(detroitMidnight('2026-01-15').toISOString()).toBe('2026-01-15T05:00:00.000Z');
    expect(detroitMidnight('2026-07-04').toISOString()).toBe('2026-07-04T04:00:00.000Z');
  });

  test('today follows the local calendar, not UTC', () => {
    expect(detroitToday(new Date('2026-10-30T03:30:00Z'))).toBe('2026-10-29');
    expect(detroitToday(new Date('2026-10-30T04:30:00Z'))).toBe('2026-10-30');
  });
});
