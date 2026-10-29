import { describe, expect, test } from 'vitest';
import { localToUtc } from '../../time';
import { SCENARIO_NAMES } from '../../types';
import { applyClockRequest, startTimeline } from '../clock';
import { NWS_WEATHER_PATTERNS } from './control-types';
import { buildGridpoint, currentIssue, observationInstants } from './forecast';
import { simCellAt, simCellPolygon } from './grid';
import { cellOffsets, relativeHumidity, SCENARIO_WEATHER, simWeatherAt } from './weather';

const cell = { x: 77, y: 40 };
/** Sim instant at a local (America/Detroit) time on Jun 9 2026. */
const jun9 = (hh: number, mm = 0) => localToUtc(2026, 6, 9, hh, mm);
const at = (
  pattern: (typeof NWS_WEATHER_PATTERNS)[number],
  ms: number,
  windMph: number | null = null,
) => simWeatherAt(ms, { pattern, cell, windMph });

describe('simulated weather patterns', () => {
  test('every scenario has a default pattern', () => {
    for (const s of SCENARIO_NAMES) expect(NWS_WEATHER_PATTERNS).toContain(SCENARIO_WEATHER[s]);
    expect(SCENARIO_WEATHER['spray-windy']).toBe('windy-morning');
  });

  test('windy-morning: light at dawn, 16 mph gusting from 09:50 to 18:20, calm night', () => {
    expect(at('windy-morning', jun9(7)).windMph).toBeLessThan(6);
    const gusty = at('windy-morning', jun9(11));
    expect(gusty.windMph).toBeGreaterThan(15);
    expect(gusty.gustMph).toBeGreaterThan(23);
    expect(at('windy-morning', jun9(17, 30)).windMph).toBeGreaterThan(15);
    expect(at('windy-morning', jun9(23)).windMph).toBeLessThan(4);
  });

  test('dawn-inversion: near calm, clear and humid at dawn; a breeze by noon', () => {
    const dawn = at('dawn-inversion', jun9(6));
    expect(dawn.windMph).toBeLessThan(3);
    expect(dawn.skyPct).toBeLessThanOrEqual(10);
    expect(dawn.rhPct).toBeGreaterThan(90);
    const noon = at('dawn-inversion', jun9(12));
    expect(noon.windMph).toBeGreaterThanOrEqual(4);
    expect(noon.windMph).toBeLessThan(8);
  });

  test('overnight-rain: rain from 00:30 to 06:30, dry afternoon, chances rising at night', () => {
    const night = at('overnight-rain', jun9(3, 30));
    expect(night.popPct).toBeGreaterThanOrEqual(80);
    expect(night.qpfIn).toBeGreaterThan(0.05);
    expect(night.skyPct).toBe(100);
    expect(at('overnight-rain', jun9(14)).qpfIn).toBe(0);
    expect(at('overnight-rain', jun9(23, 30)).popPct).toBeGreaterThan(50);
  });

  test('calm: 2-3 mph at night, 4-7 mph by day, dry', () => {
    expect(at('calm', jun9(2)).windMph).toBeLessThan(3.5);
    const day = at('calm', jun9(13));
    expect(day.windMph).toBeGreaterThan(3.5);
    expect(day.windMph).toBeLessThan(8);
    expect(day.qpfIn).toBe(0);
  });

  test('the wind slider pins the sustained wind (within the cell offset); gusts follow', () => {
    const w = at('windy-morning', jun9(11), 5);
    expect(Math.abs(w.windMph - 5)).toBeLessThanOrEqual(0.8);
    expect(w.gustMph).toBeCloseTo(w.windMph * 1.3 + 1);
    expect(at('calm', jun9(11), 0).windMph).toBeGreaterThanOrEqual(0);
  });

  test('seasons, cells and humidity stay in physical ranges', () => {
    const jan = simWeatherAt(localToUtc(2026, 1, 15, 14), { pattern: 'calm', cell, windMph: null });
    const jul = simWeatherAt(localToUtc(2026, 7, 20, 15), { pattern: 'calm', cell, windMph: null });
    expect(jan.tempF).toBeLessThan(40);
    expect(jul.tempF).toBeGreaterThan(75);
    for (let x = 0; x < 50; x++) {
      const o = cellOffsets({ x, y: x * 3 });
      expect(Math.abs(o.wind)).toBeLessThanOrEqual(0.8);
      expect(Math.abs(o.temp)).toBeLessThanOrEqual(1);
    }
    expect(relativeHumidity(50, 50)).toBeCloseTo(100);
    expect(relativeHumidity(80, 50)).toBeGreaterThan(30);
    expect(relativeHumidity(80, 50)).toBeLessThan(40);
  });
});

describe('the stand-in grid and forecast issues', () => {
  test('cells are 2.5 km and contain their points', () => {
    const c = simCellAt(-84.03, 41.9);
    expect(c).not.toBeNull();
    const ring = simCellPolygon(c?.x ?? 0, c?.y ?? 0).coordinates[0] ?? [];
    const lngs = ring.map((p) => p[0] as number);
    const lats = ring.map((p) => p[1] as number);
    expect(Math.min(...lngs)).toBeLessThanOrEqual(-84.03);
    expect(Math.max(...lngs)).toBeGreaterThan(-84.03);
    expect((Math.max(...lats) - Math.min(...lats)) * 111.2).toBeCloseTo(2.5, 2);
    expect(simCellAt(-90, 41.9)).toBeNull();
  });

  test('an issue is stable while the clock segment lasts, also while paused', () => {
    const t0 = new Date('2026-10-29T12:00:02Z');
    let tl = startTimeline(new Date('2026-06-09T10:00:00Z'), t0, { speed: 1 });
    const a = currentIssue(tl, new Date(t0.getTime() + 20 * 60_000), null);
    expect(a.updateMs).toBe(t0.getTime());
    tl = applyClockRequest(tl, { action: 'pause' }, new Date(t0.getTime() + 30 * 60_000));
    const paused = currentIssue(tl, new Date(t0.getTime() + 5 * 3_600_000), null);
    expect(paused).toEqual(a);
    // A knob change starts a new issue at the change time.
    const changed = new Date(t0.getTime() + 40 * 60_000).toISOString();
    expect(currentIssue(tl, new Date(t0.getTime() + 41 * 60_000), changed).updateMs).toBe(
      Date.parse(changed),
    );
    // At 30x a sim hour is two wall minutes.
    const fast = startTimeline(new Date('2026-06-09T10:00:00Z'), t0, { speed: 30 });
    const b = currentIssue(fast, new Date(t0.getTime() + 3 * 60_000), null);
    expect(b.updateMs).toBe(t0.getTime() + 2 * 60_000);
  });

  test('gridpoint layers are run-length coded; QPF in 6-hour UTC blocks', () => {
    const t0 = new Date('2026-10-29T12:20:00Z');
    const tl = startTimeline(new Date('2026-06-09T04:00:00Z'), t0, { speed: 1 });
    const issue = currentIssue(tl, t0, null);
    const body = buildGridpoint({
      base: 'http://127.0.0.1:4010/nws',
      wfo: 'DTX',
      x: 77,
      y: 40,
      issue,
      pattern: 'overnight-rain',
      windMph: null,
    }) as { properties: Record<string, { values: { validTime: string; value: number }[] }> };
    const qpf = body.properties.quantitativePrecipitation?.values ?? [];
    expect(qpf[0]?.validTime).toBe('2026-10-29T12:00:00+00:00/PT6H');
    expect(
      qpf.slice(1).every((v) => /T(00|06|12|18):00:00\+00:00\/PT\d+H$/.test(v.validTime)),
    ).toBe(true);
    const sky = body.properties.skyCover?.values ?? [];
    expect(sky.length).toBeLessThan(7 * 24);
    expect(sky.some((v) => !v.validTime.endsWith('/PT1H'))).toBe(true);
  });

  test('observation instants: the 20-minute grid, newest first, limited', () => {
    const now = Date.parse('2026-10-29T12:05:00Z');
    expect(
      observationInstants(now - 3_600_000, now, 10).map((t) => new Date(t).toISOString()),
    ).toEqual(['2026-10-29T12:00:00.000Z', '2026-10-29T11:40:00.000Z', '2026-10-29T11:20:00.000Z']);
    expect(observationInstants(now - 3_600_000, now, 1)).toHaveLength(1);
  });
});
