import { describe, expect, test } from 'vitest';
import { ago, detroitTime, short } from './format';

describe('admin formatting', () => {
  const now = new Date('2026-10-29T15:00:00.000Z');

  test('ago', () => {
    expect(ago(null, now)).toBe('-');
    expect(ago(new Date('2026-10-29T14:59:48.000Z'), now)).toBe('12 s ago');
    expect(ago('2026-10-29T14:57:00.000Z', now)).toBe('3 min ago');
    expect(ago(new Date('2026-10-29T13:00:00.000Z'), now)).toBe('2 h ago');
    expect(ago(new Date('2026-10-25T15:00:00.000Z'), now)).toBe('4 d ago');
    expect(ago(new Date('2026-10-29T15:00:20.000Z'), now)).toBe('in 20 s');
    expect(ago('garbage', now)).toBe('-');
  });

  test('detroitTime shows America/Detroit (EDT until Nov 1, 2026)', () => {
    expect(detroitTime(now)).toBe('Oct 29, 11:00:00 AM');
    expect(detroitTime(new Date('2026-12-01T17:30:05.000Z'))).toBe('Dec 1, 12:30:05 PM');
    expect(detroitTime(null)).toBe('-');
  });

  test('short', () => {
    expect(short('abc', 5)).toBe('abc');
    expect(short('abcdefgh', 5)).toBe('abcd…');
    expect(short(null)).toBe('');
  });
});
