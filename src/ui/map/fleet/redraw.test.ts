import { describe, expect, test } from 'vitest';
import type { MachineView } from '../../../domain/fleet';
import { glideRates } from './glide';
import { FleetModel } from './model';
import {
  insideGrown,
  MAX_REDRAW_INTERVAL_MS,
  MIN_STEP_DEVICE_PX,
  metersPerCssPixel,
  NO_MOTION,
  redrawIntervalMs,
} from './redraw';

const T0 = Date.parse('2026-10-29T14:00:00Z');
const LAT = 41.9; // the demo farm

function machine(over: Partial<MachineView> = {}): MachineView {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    unitNo: 'S1',
    kind: 'semi',
    lng: -84.0,
    lat: LAT,
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

describe('metersPerCssPixel', () => {
  test('matches Web Mercator ground resolution for 512 px tiles', () => {
    // Equator, zoom 0: the world (40 075 km) is 512 px wide.
    expect(metersPerCssPixel(0, 0)).toBeCloseTo(40_075_016.686 / 512, 6);
    // Each zoom level halves it; at 60° N it is half the equator's.
    expect(metersPerCssPixel(0, 1)).toBeCloseTo(metersPerCssPixel(0, 0) / 2, 6);
    expect(metersPerCssPixel(60, 10)).toBeCloseTo(metersPerCssPixel(0, 10) / 2, 6);
    // The farm at zoom 15: under 2 m a pixel.
    expect(metersPerCssPixel(LAT, 15)).toBeGreaterThan(1.7);
    expect(metersPerCssPixel(LAT, 15)).toBeLessThan(1.8);
  });
});

describe('redrawIntervalMs', () => {
  const truck = { metersPerSecond: 24.6, degreesPerSecond: 0 }; // 55 mph
  const combine = { metersPerSecond: 2, degreesPerSecond: 0 }; // 4.5 mph

  test('one frame per half device pixel of movement', () => {
    const mpp = 2; // m per CSS px
    // 24.6 m/s = 12.3 CSS px/s = 24.6 device px/s at DPR 2: half a pixel every ~20 ms.
    expect(redrawIntervalMs(truck, mpp, 2, 22)).toBeCloseTo(
      (MIN_STEP_DEVICE_PX / ((24.6 / mpp) * 2)) * 1000,
      6,
    );
    // Twice the device pixels, half the interval.
    expect(redrawIntervalMs(truck, mpp, 2, 22)).toBeCloseTo(
      redrawIntervalMs(truck, mpp, 1, 22) / 2,
      6,
    );
  });

  test('the wall at the farm zoom redraws a gliding fleet a few times a second, not 60', () => {
    const z11 = metersPerCssPixel(LAT, 11);
    expect(redrawIntervalMs(truck, z11, 2, 22)).toBeGreaterThan(200);
    expect(redrawIntervalMs(combine, z11, 2, 22)).toBe(MAX_REDRAW_INTERVAL_MS);
    // Zoomed in on a road, a truck is smooth again (about every animation frame).
    expect(redrawIntervalMs(truck, metersPerCssPixel(LAT, 17), 2, 22)).toBeLessThan(17);
  });

  test('a turn counts by how far the icon edge sweeps', () => {
    // 90° in 5 s on a 22 px ring: 18°/s = 6.9 px/s of sweep at DPR 1.
    const turning = { metersPerSecond: 0, degreesPerSecond: 18 };
    const sweep = ((18 * Math.PI) / 180) * 22;
    expect(redrawIntervalMs(turning, 10, 1, 22)).toBeCloseTo((0.5 / sweep) * 1000, 6);
  });

  test('no motion: the slowest pace; a bad scale or speed: every frame', () => {
    expect(redrawIntervalMs(NO_MOTION, 2, 2, 22)).toBe(MAX_REDRAW_INTERVAL_MS);
    expect(redrawIntervalMs(truck, 0, 2, 22)).toBe(0);
    expect(redrawIntervalMs(truck, Number.NaN, 2, 22)).toBe(0);
    expect(
      redrawIntervalMs(
        { metersPerSecond: Number.POSITIVE_INFINITY, degreesPerSecond: 0 },
        2,
        2,
        22,
      ),
    ).toBe(0);
    // An unusable device pixel ratio counts as 1.
    expect(redrawIntervalMs(truck, 2, Number.NaN, 22)).toBe(redrawIntervalMs(truck, 2, 1, 22));
    expect(redrawIntervalMs(truck, 2, 0, 22)).toBe(redrawIntervalMs(truck, 2, 1, 22));
  });
});

describe('insideGrown', () => {
  test('grows the box by a fraction of its size on every side', () => {
    const inside = insideGrown({ west: -84, south: 41, east: -83, north: 42 }, 0.1);
    expect(inside(-83.5, 41.5)).toBe(true);
    expect(inside(-84.09, 41.95)).toBe(true);
    expect(inside(-82.91, 40.91)).toBe(true);
    expect(inside(-84.11, 41.5)).toBe(false);
    expect(inside(-83.5, 42.11)).toBe(false);
  });
});

describe('glideRates and FleetModel.motion', () => {
  test('a glide moves at its distance over its duration, turning the short way', () => {
    const g = {
      from: { lng: 0, lat: 0, heading: 350 },
      to: { lng: 0.001, lat: 0, heading: 10 },
      start: 0,
      duration: 4000,
    };
    const r = glideRates(g, 1000);
    expect(r.metersPerSecond).toBeCloseTo(111.195 / 4, 2);
    expect(r.degreesPerSecond).toBeCloseTo(5, 9);
    expect(glideRates(g, 4000)).toEqual({ metersPerSecond: 0, degreesPerSecond: 0 });
  });

  test('the fastest machine in view, nothing once the glides end', () => {
    const m = new FleetModel({ staleAfterSeconds: 90, wallNow: () => new Date(T0) });
    const slow = machine({ id: '00000000-0000-4000-8000-000000000002', unitNo: 'C1' });
    const fast = machine({ lat: 42.5 });
    m.applySnapshot([slow, fast], 0);
    expect(m.motion(0)).toEqual(NO_MOTION);
    const t5 = new Date(T0 + 5000).toISOString();
    m.applyTick(
      [
        { ...slow, lng: slow.lng + 0.0001, ts: t5 }, // ~8 m in 5 s
        { ...fast, lng: fast.lng + 0.001, ts: t5 }, // ~82 m in 5 s
      ],
      1000,
    );
    const all = m.motion(2000);
    expect(all.metersPerSecond).toBeGreaterThan(15);
    expect(all.metersPerSecond).toBeLessThan(18);
    // Only the slow one is on screen (the fast one is 60 km north).
    const onScreen = m.motion(2000, (_lng, lat) => lat < 42);
    expect(onScreen.metersPerSecond).toBeGreaterThan(1.5);
    expect(onScreen.metersPerSecond).toBeLessThan(1.8);
    expect(m.motion(6000)).toEqual(NO_MOTION);
  });
});
