import { describe, expect, test } from 'vitest';
import { type FleetTick, fleetTickSchema, isStale, normalizeHeading } from './fleet';
import { demoId, deterministicId, isUuid } from './ids';

const tick: FleetTick = {
  ts: '2026-10-28T15:00:00.000Z',
  machines: [
    {
      id: demoId('machine-c1'),
      unitNo: 'C1',
      kind: 'combine',
      lng: -84.04,
      lat: 41.9,
      heading: 92.5,
      speedMph: 4.2,
      activity: 'working',
      fieldId: demoId('field-1'),
      positionSource: 'deere_working',
      ts: '2026-10-28T14:59:58.000Z',
      status: 'active',
      stale: false,
    },
  ],
};

describe('fleet contract', () => {
  test('a valid tick parses', () => {
    expect(fleetTickSchema.parse(tick)).toEqual(tick);
  });

  test('rejects bad headings and kinds', () => {
    const bad = structuredClone(tick);
    const m = bad.machines[0];
    if (!m) throw new Error('fixture');
    m.heading = 360;
    expect(fleetTickSchema.safeParse(bad).success).toBe(false);
    m.heading = 0;
    (m as { kind: string }).kind = 'hovercraft';
    expect(fleetTickSchema.safeParse(bad).success).toBe(false);
  });

  test('isStale uses wall clock and the threshold', () => {
    const now = new Date('2026-10-28T15:10:00Z');
    expect(isStale('2026-10-28T15:00:01Z', now)).toBe(false);
    expect(isStale('2026-10-28T14:59:59Z', now)).toBe(true);
    expect(isStale(new Date('2026-10-28T15:09:00Z'), now, 30)).toBe(true);
    expect(isStale('not a date', now)).toBe(true);
  });

  test('normalizeHeading', () => {
    expect(normalizeHeading(-90)).toBe(270);
    expect(normalizeHeading(720)).toBe(0);
    expect(normalizeHeading(null)).toBe(0);
    expect(normalizeHeading(Number.NaN)).toBe(0);
  });
});

describe('deterministic ids', () => {
  test('stable across runs (never change ID_NAMESPACE)', () => {
    expect(deterministicId('samsara', '212014918732')).toBe(
      deterministicId('samsara', '212014918732'),
    );
    expect(demoId('field-1')).toBe(deterministicId('demo', 'field-1'));
    expect(deterministicId('demo', 'field-1')).not.toBe(deterministicId('sim', 'field-1'));
    expect(isUuid(demoId('x'))).toBe(true);
    // Pinned value: if this changes, every stored deterministic id breaks.
    expect(deterministicId('demo', 'field-1')).toBe('b7578915-9ad0-5b42-9c6f-e5c13d7c4665');
  });

  test('requires both parts', () => {
    expect(() => deterministicId('', 'x')).toThrow();
    expect(() => deterministicId('deere', '')).toThrow();
  });
});
