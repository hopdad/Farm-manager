import { describe, expect, test } from 'vitest';
import { compassPoint, formatAge, formatClock, formatDuration } from './format';

describe('board formatting', () => {
  const now = Date.parse('2026-10-29T14:00:00Z');
  test('formatAge', () => {
    const ago = (s: number) => new Date(now - s * 1000).toISOString();
    expect(formatAge(ago(2), now)).toBe('just now');
    expect(formatAge(ago(-30), now)).toBe('just now');
    expect(formatAge(ago(42), now)).toBe('42 s ago');
    expect(formatAge(ago(300), now)).toBe('5 min ago');
    expect(formatAge(ago(7200), now)).toBe('2 h ago');
    expect(formatAge(ago(86400 * 3), now)).toBe('3 d ago');
    expect(formatAge('nope', now)).toBe('unknown');
  });

  test('formatDuration', () => {
    expect(formatDuration(90)).toBe('90 s');
    expect(formatDuration(600)).toBe('10 min');
    expect(formatDuration(10_800)).toBe('3 h');
  });

  test('formatClock shows America/Detroit time', () => {
    // 14:00 UTC on Oct 29 is 10:00 EDT.
    expect(formatClock(new Date(now))).toEqual({ time: '10:00 AM', date: 'Thu, Oct 29' });
    // After DST ends (Nov 1, 2026) Detroit is UTC-5.
    expect(formatClock(new Date('2026-11-02T14:00:00Z')).time).toBe('9:00 AM');
  });

  test('compassPoint', () => {
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(44)).toBe('NE');
    expect(compassPoint(180)).toBe('S');
    expect(compassPoint(359)).toBe('N');
    expect(compassPoint(-90)).toBe('W');
  });
});
