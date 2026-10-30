import { describe, expect, test } from 'vitest';
import {
  DEFAULT_LAST_KNOWN_STALE_AFTER_SECONDS,
  type FleetTick,
  fleetTickSchema,
  isMachineStale,
  isPositionVendor,
  isStale,
  MACHINE_KINDS,
  normalizeHeading,
  positionVendorId,
  staleAfterFor,
} from './fleet';
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

describe('stale thresholds by position source', () => {
  const now = new Date('2026-10-28T15:10:00Z');
  const t = { staleAfterSeconds: 60, deereStaleAfterSeconds: 900 };
  test('ELD and cab fixes use FLEET_STALE_SECONDS, Deere fixes FLEET_STALE_SECONDS_DEERE', () => {
    expect(staleAfterFor('eld', t)).toBe(60);
    expect(staleAfterFor('cab_device', t)).toBe(60);
    expect(staleAfterFor('manual', t)).toBe(60);
    expect(staleAfterFor('deere_working', t)).toBe(900);
    expect(staleAfterFor('deere_working', 30)).toBe(30);
  });
  test('a 5-minute-old fix is stale from an ELD but not from Deere', () => {
    const ts = '2026-10-28T15:05:00Z';
    expect(isMachineStale({ ts, positionSource: 'eld' }, now, t)).toBe(true);
    expect(isMachineStale({ ts, positionSource: 'deere_working' }, now, t)).toBe(false);
    expect(
      isMachineStale({ ts: '2026-10-28T14:50:00Z', positionSource: 'deere_working' }, now, t),
    ).toBe(true);
  });
});

describe('1f.2: vendor ids and last-known fixes', () => {
  test('position vendor ids: any registry-style id, <route>_<provider> for aggregators', () => {
    expect(positionVendorId('samsara')).toBe('samsara');
    expect(positionVendorId('aemp', 'kubota')).toBe('aemp_kubota');
    expect(positionVendorId('terminal', 'Omni-Tracs')).toBe('terminal_omni_tracs');
    expect(positionVendorId('aemp', null)).toBe('aemp');
    for (const ok of ['geotab', 'cnh', 'aemp_kubota']) expect(isPositionVendor(ok)).toBe(true);
    for (const bad of ['Geotab', 'a', 'aemp-kubota', '', 7])
      expect(isPositionVendor(bad)).toBe(false);
    expect(() => positionVendorId('9x')).toThrow(/bad id/);
  });

  test('a last-known snapshot goes stale on its own, longer threshold', () => {
    const now = new Date('2026-10-15T15:00:00Z');
    const t = { staleAfterSeconds: 600, deereStaleAfterSeconds: 900 };
    const ts = new Date(now.getTime() - 2 * 3600_000).toISOString(); // two hours old
    expect(isMachineStale({ ts, positionSource: 'eld' }, now, t)).toBe(true);
    expect(isMachineStale({ ts, positionSource: 'eld', positionKind: 'last_known' }, now, t)).toBe(
      false,
    );
    expect(staleAfterFor('eld', t, 'last_known')).toBe(DEFAULT_LAST_KNOWN_STALE_AFTER_SECONDS);
    expect(staleAfterFor('eld', { ...t, lastKnownStaleAfterSeconds: 3600 }, 'last_known')).toBe(
      3600,
    );
    expect(staleAfterFor('eld', 60, 'last_known')).toBe(60);
    // Never below the others when unset (a PC with long thresholds).
    expect(
      staleAfterFor(
        'eld',
        { staleAfterSeconds: 20_000, deereStaleAfterSeconds: 900 },
        'last_known',
      ),
    ).toBe(20_000);
  });

  test('the new kinds parse in a tick', () => {
    for (const kind of ['service_truck', 'loader'] as const) {
      expect(MACHINE_KINDS).toContain(kind);
    }
  });
});
