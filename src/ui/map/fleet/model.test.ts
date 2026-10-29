import { describe, expect, test } from 'vitest';
import type { MachineView } from '../../../domain/fleet';
import { distanceMeters, glideAt, lerpHeading, nextIntervalEstimate, stationary } from './glide';
import { FleetModel } from './model';

const T0 = Date.parse('2026-10-29T14:00:00Z');

function machine(over: Partial<MachineView> = {}): MachineView {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    unitNo: 'S1',
    kind: 'semi',
    lng: -84.0,
    lat: 41.9,
    heading: 90,
    speedMph: 45,
    activity: 'transport',
    fieldId: null,
    positionSource: 'eld',
    ts: new Date(T0).toISOString(),
    status: 'active',
    stale: false,
    ...over,
  };
}

function model(wall = { now: T0 }, staleAfterSeconds = 90) {
  return new FleetModel({ staleAfterSeconds, wallNow: () => new Date(wall.now) });
}

describe('interpolation helpers', () => {
  test('lerpHeading turns the short way round', () => {
    expect(lerpHeading(350, 10, 0.5)).toBeCloseTo(0, 9);
    expect(lerpHeading(10, 350, 0.5)).toBeCloseTo(0, 9);
    expect(lerpHeading(0, 90, 0.5)).toBe(45);
    expect(lerpHeading(270, 90, 0.25)).toBeCloseTo(225, 9);
    expect(lerpHeading(359, 1, 1)).toBeCloseTo(1, 9);
  });

  test('glideAt moves at constant speed and stops at the target', () => {
    const g = {
      from: { lng: 0, lat: 0, heading: 0 },
      to: { lng: 1, lat: 2, heading: 90 },
      start: 1000,
      duration: 1000,
    };
    expect(glideAt(g, 500)).toEqual(g.from);
    expect(glideAt(g, 1500)).toEqual({ lng: 0.5, lat: 1, heading: 45 });
    expect(glideAt(g, 5000)).toEqual(g.to);
    expect(glideAt(stationary(g.to, 0), 0)).toEqual(g.to);
  });

  test('distanceMeters', () => {
    // One degree of latitude ≈ 111.2 km.
    expect(distanceMeters({ lng: 0, lat: 0 }, { lng: 0, lat: 1 })).toBeCloseTo(111_195, -2);
    expect(distanceMeters({ lng: -84, lat: 41.9 }, { lng: -84, lat: 41.9 })).toBe(0);
  });

  test('tick interval estimate: EMA, clamped, ignoring long gaps', () => {
    expect(nextIntervalEstimate(5000, 5000, 1000, 30000)).toBe(5000);
    expect(nextIntervalEstimate(5000, 3000, 1000, 30000)).toBe(4000);
    expect(nextIntervalEstimate(5000, 100, 1000, 30000)).toBe(3000);
    expect(nextIntervalEstimate(5000, 200_000, 1000, 30000)).toBe(5000);
    expect(nextIntervalEstimate(29000, 60000, 1000, 30000)).toBe(29500);
  });
});

describe('FleetModel', () => {
  test('a snapshot places machines without gliding', () => {
    const m = model();
    m.applySnapshot([machine()], 0);
    expect(m.isAnimating(0)).toBe(false);
    expect(m.frame(0)[0]).toMatchObject({ unitNo: 'S1', lng: -84, lat: 41.9, heading: 90 });
  });

  test('a tick glides from the drawn position to the new fix over the tick interval', () => {
    const m = model();
    m.applySnapshot([machine()], 0);
    const next = machine({ lng: -83.99, ts: new Date(T0 + 5000).toISOString() });
    m.applyTick([next], 1000);
    expect(m.tickIntervalMs).toBe(5000);
    expect(m.isAnimating(1000)).toBe(true);
    expect(m.frame(1000)[0]?.lng).toBeCloseTo(-84, 9);
    expect(m.frame(3500)[0]?.lng).toBeCloseTo(-83.995, 9);
    expect(m.frame(6000)[0]?.lng).toBeCloseTo(-83.99, 9);
    expect(m.isAnimating(6000)).toBe(false);
  });

  test('a tick mid-glide starts from where the marker is drawn, not where it was heading', () => {
    const m = model();
    m.applySnapshot([machine({ lng: 0, lat: 0 })], 0);
    m.applyTick([machine({ lng: 0.01, lat: 0, ts: new Date(T0 + 1).toISOString() })], 0);
    // Halfway (2.5 s of 5 s) a new fix arrives.
    m.applyTick([machine({ lng: 0.02, lat: 0, ts: new Date(T0 + 2).toISOString() })], 2500);
    expect(m.frame(2500)[0]?.lng).toBeCloseTo(0.005, 9);
  });

  test('the glide length follows the measured tick interval', () => {
    const m = model();
    m.applySnapshot([machine()], 0);
    for (let i = 1; i <= 6; i++) {
      m.applyTick(
        [machine({ lng: -84 + i * 0.001, ts: new Date(T0 + i * 2000).toISOString() })],
        i * 2000,
      );
    }
    expect(m.tickIntervalMs).toBeGreaterThan(1900);
    expect(m.tickIntervalMs).toBeLessThan(2200);
  });

  test('an out-of-order (older) fix is ignored', () => {
    const m = model();
    m.applySnapshot([machine({ lng: -83.9, ts: new Date(T0 + 10_000).toISOString() })], 0);
    m.applyTick([machine({ lng: -84.5, ts: new Date(T0).toISOString() })], 100);
    expect(m.frame(10_000)[0]?.lng).toBe(-83.9);
  });

  test('long jumps snap instead of gliding across the county', () => {
    const m = model();
    m.applySnapshot([machine({ lng: -84.4 })], 0);
    m.applyTick([machine({ lng: -83.2, ts: new Date(T0 + 1000).toISOString() })], 10);
    expect(m.isAnimating(10)).toBe(false);
    expect(m.frame(10)[0]?.lng).toBe(-83.2);
  });

  test('a snapshot drops machines it no longer contains; ticks only upsert', () => {
    const m = model();
    const a = machine();
    const b = machine({
      id: '00000000-0000-4000-8000-000000000002',
      unitNo: 'C1',
      kind: 'combine',
    });
    m.applySnapshot([a, b], 0);
    m.applyTick([a], 1);
    expect(m.size).toBe(2);
    m.applySnapshot([b], 2);
    expect(m.frame(2).map((f) => f.unitNo)).toEqual(['C1']);
  });

  test('staleness is re-evaluated on the wall clock without any tick', () => {
    const wall = { now: T0 + 10_000 };
    const m = model(wall, 90);
    m.applySnapshot([machine({ stale: false })], 0);
    expect(m.counts()).toEqual({ total: 1, stale: 0, down: 0 });
    wall.now = T0 + 89_000;
    expect(m.refreshStaleness()).toBe(false);
    wall.now = T0 + 91_000;
    const v = m.version;
    expect(m.refreshStaleness()).toBe(true);
    expect(m.version).toBe(v + 1);
    expect(m.counts().stale).toBe(1);
    expect(m.frame(0)[0]?.stale).toBe(true);
    // A fresh fix clears it.
    m.applyTick([machine({ ts: new Date(wall.now).toISOString() })], 1);
    expect(m.counts().stale).toBe(0);
  });

  test('the server stale flag does not override the browser clock', () => {
    const m = model({ now: T0 });
    m.applySnapshot([machine({ stale: true })], 0);
    expect(m.counts().stale).toBe(0);
  });

  test('frames are ordered by unit number (numeric) and count down machines', () => {
    const m = model();
    m.applySnapshot(
      [
        machine({ id: '00000000-0000-4000-8000-00000000000a', unitNo: 'S10' }),
        machine({ id: '00000000-0000-4000-8000-00000000000b', unitNo: 'S2', status: 'down' }),
        machine({ id: '00000000-0000-4000-8000-00000000000c', unitNo: 'C1' }),
      ],
      0,
    );
    expect(m.frame(0).map((f) => f.unitNo)).toEqual(['C1', 'S2', 'S10']);
    expect(m.counts().down).toBe(1);
  });
});
