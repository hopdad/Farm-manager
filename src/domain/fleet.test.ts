import { describe, expect, test } from 'vitest';
import {
  DEERE_LAST_WORKING_MAX_SECONDS,
  DEERE_STOPPED_WORKING_SECONDS,
  DEFAULT_LAST_KNOWN_STALE_AFTER_SECONDS,
  deereFeedOf,
  deereStoppedWorkingSeconds,
  type FleetTick,
  fleetTickSchema,
  isLastWorking,
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

describe('isLastWorking (1f, §5.3)', () => {
  const t = { staleAfterSeconds: 60, deereStaleAfterSeconds: 900 };
  const at = (ms: number) => new Date(Date.parse('2026-10-31T14:00:00Z') + ms);
  const fix = { ts: '2026-10-31T14:00:00.000Z', positionSource: 'deere_working' as const };
  test('a Deere working-only fix older than 3 min (or the Deere stale threshold if lower)', () => {
    expect(isLastWorking(fix, at(179_000), t)).toBe(false);
    expect(isLastWorking(fix, at(180_000), t)).toBe(true);
    expect(isLastWorking(fix, at(60_000), { ...t, deereStaleAfterSeconds: 60 })).toBe(true);
    expect(deereStoppedWorkingSeconds(t)).toBe(DEERE_STOPPED_WORKING_SECONDS);
  });
  test('never for other sources or a last-known snapshot', () => {
    expect(isLastWorking({ ...fix, positionSource: 'eld' }, at(3_600_000), t)).toBe(false);
    expect(isLastWorking({ ...fix, positionKind: 'last_known' }, at(3_600_000), t)).toBe(false);
  });

  // 1f review: judged against the Deere feed's last OK poll, not the wall clock.
  const feed = (okMs: number | null, failing = false) => ({
    connection: 'deere',
    lastOkAt: okMs === null ? null : at(okMs).toISOString(),
    failing,
  });
  test('a working machine waiting for the next poll stays working, however long the interval', () => {
    // Polled 90 s after its newest breadcrumb (a minute and a half late): working, also 4 min
    // later while a paced fleet.deere hasn't polled again (before: "Last working" at 3 min).
    expect(isLastWorking(fix, at(90_000), t, feed(90_000))).toBe(false);
    expect(isLastWorking(fix, at(330_000), t, feed(90_000))).toBe(false);
    // The next poll, 3 min or more after that breadcrumb, brought nothing newer: it stopped.
    expect(isLastWorking(fix, at(330_000), t, feed(300_000))).toBe(true);
  });
  test('a failing or silent Deere connection is not a parked machine', () => {
    // Stopped working, then the token was revoked: the next runs fail.
    expect(isLastWorking(fix, at(400_000), t, feed(300_000, true))).toBe(false);
    // No successful poll within FLEET_STALE_SECONDS_DEERE (the job not running at all).
    expect(isLastWorking(fix, at(300_000 + 901_000), t, feed(300_000))).toBe(false);
    expect(isLastWorking(fix, at(400_000), t, feed(null))).toBe(false);
    // No Deere feed listed at all (Deere off): not last working either.
    expect(isLastWorking(fix, at(400_000), t, null)).toBe(false);
    expect(
      deereFeedOf([feed(1), { connection: 'samsara', lastOkAt: null, failing: true }]),
    ).toEqual(feed(1));
    expect(deereFeedOf(undefined)).toBeUndefined();
    expect(deereFeedOf([])).toBeNull();
  });
  test('a machine stopped longer than DEERE_LAST_WORKING_MAX_SECONDS reads stale after all', () => {
    const max = DEERE_LAST_WORKING_MAX_SECONDS * 1000;
    expect(isLastWorking(fix, at(max), t, feed(max - 60_000))).toBe(true);
    expect(isLastWorking(fix, at(max + 1_000), t, feed(max))).toBe(false);
    expect(isLastWorking(fix, at(max + 1_000), t)).toBe(false);
    expect(isMachineStale(fix, at(max + 1_000), t)).toBe(true);
  });
});
