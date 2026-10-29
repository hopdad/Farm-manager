import { describe, expect, test } from 'vitest';
import { hash32, Rng, rngFor } from './rng';
import {
  civilDayNumber,
  civilFromDayNumber,
  detroitOffsetMinutes,
  hhmm,
  localDayTime,
  localParts,
  localToUtc,
} from './time';

describe('America/Detroit without ICU', () => {
  test('EST / EDT offsets around the 2026 transitions', () => {
    // DST 2026: Mar 8 07:00Z -> Nov 1 06:00Z.
    expect(detroitOffsetMinutes(Date.parse('2026-03-08T06:59:59Z'))).toBe(-300);
    expect(detroitOffsetMinutes(Date.parse('2026-03-08T07:00:00Z'))).toBe(-240);
    expect(detroitOffsetMinutes(Date.parse('2026-11-01T05:59:59Z'))).toBe(-240);
    expect(detroitOffsetMinutes(Date.parse('2026-11-01T06:00:00Z'))).toBe(-300);
    expect(detroitOffsetMinutes(Date.parse('2026-01-15T14:00:00Z'))).toBe(-300);
    expect(detroitOffsetMinutes(Date.parse('2026-10-15T11:00:00Z'))).toBe(-240);
  });

  test('agrees with Intl for a year of hourly instants', () => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Detroit',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    for (
      let t = Date.parse('2026-01-01T00:00:00Z');
      t < Date.parse('2027-01-01T00:00:00Z');
      t += 3_600_000 * 7
    ) {
      const lp = localParts(t);
      const parts = Object.fromEntries(
        fmt.formatToParts(new Date(t)).map((p) => [p.type, p.value]),
      );
      expect([lp.y, lp.m, lp.d, lp.hh, lp.mm]).toEqual([
        Number(parts.year),
        Number(parts.month),
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
      ]);
    }
  });

  test('local -> UTC round-trips and day numbers', () => {
    const t = localToUtc(2026, 10, 15, 7, 0);
    expect(new Date(t).toISOString()).toBe('2026-10-15T11:00:00.000Z');
    expect(new Date(localToUtc(2026, 1, 15, 9, 0)).toISOString()).toBe('2026-01-15T14:00:00.000Z');
    const n = civilDayNumber(2026, 10, 15);
    expect(civilFromDayNumber(n)).toEqual({ y: 2026, m: 10, d: 15 });
    expect(new Date(localDayTime(n, hhmm('07:30'))).toISOString()).toBe('2026-10-15T11:30:00.000Z');
    expect(localParts(t).minuteOfDay).toBe(420);
    expect(() => hhmm('7')).toThrow(/HH:MM/);
  });
});

describe('deterministic randomness', () => {
  test('same seed and labels, same stream; labels are independent', () => {
    const a = rngFor(1, 'fields', 'adrian');
    const b = rngFor(1, 'fields', 'adrian');
    const xs = Array.from({ length: 50 }, () => a.next());
    expect(Array.from({ length: 50 }, () => b.next())).toEqual(xs);
    expect(rngFor(1, 'fields', 'dundee').next()).not.toBe(xs[0]);
    expect(rngFor(2, 'fields', 'adrian').next()).not.toBe(xs[0]);
    expect(hash32('a', 1)).toBe(hash32('a', 1));
    expect(hash32('a', 1)).not.toBe(hash32('a1'));
  });

  test('ranges, ints, picks and shuffles stay in bounds', () => {
    const r = new Rng(42);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v >= 0 && v < 1).toBe(true);
      const k = r.int(3, 5);
      expect(k >= 3 && k <= 5 && Number.isInteger(k)).toBe(true);
    }
    const items = ['a', 'b', 'c', 'd', 'e'];
    expect([...r.shuffle(items)].sort()).toEqual(items);
    expect(items).toContain(r.pick(items));
    expect(() => r.pick([])).toThrow(/empty/);
  });
});
