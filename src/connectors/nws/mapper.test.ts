import { describe, expect, test } from 'vitest';
import {
  expandLayer,
  mapGridpoint,
  mapObservation,
  mapStations,
  parseIsoDuration,
  parseValidTime,
  stationIdOf,
  trimGridpoint,
} from './mapper';
import { type NwsGridpoint, nwsGridpointSchema, nwsObservationSchema } from './schemas';
import { bareUnit, converter, NwsUnitError } from './units';

const H = 3_600_000;
const T0 = Date.parse('2026-10-29T12:00:00Z');

describe('ISO 8601 intervals (NWS validTime)', () => {
  test('start/duration, start/end, duration/end', () => {
    expect(parseValidTime('2026-10-29T12:00:00+00:00/PT3H')).toEqual({
      start: T0,
      end: T0 + 3 * H,
    });
    expect(parseValidTime('2026-10-29T12:00:00+00:00/P1DT6H')).toEqual({
      start: T0,
      end: T0 + 30 * H,
    });
    expect(parseValidTime('2026-10-29T12:00:00Z/2026-10-29T14:00:00Z')).toEqual({
      start: T0,
      end: T0 + 2 * H,
    });
    expect(parseValidTime('PT2H/2026-10-29T14:00:00+00:00')).toEqual({
      start: T0,
      end: T0 + 2 * H,
    });
    // Offsets other than UTC.
    expect(parseValidTime('2026-10-29T08:00:00-04:00/PT1H').start).toBe(T0);
  });

  test('durations with weeks, minutes and seconds; bad input throws', () => {
    expect(parseIsoDuration('P1W')).toMatchObject({ weeks: 1 });
    expect(parseIsoDuration('PT1H30M15S')).toMatchObject({ hours: 1, minutes: 30, seconds: 15 });
    for (const bad of ['P', 'PT', '1H', 'P1H']) expect(() => parseIsoDuration(bad)).toThrow();
    expect(() => parseValidTime('2026-10-29T12:00:00Z')).toThrow();
    expect(() => parseValidTime('PT1H/PT2H')).toThrow();
    expect(() => parseValidTime('2026-10-29T12:00:00Z/PT0H')).toThrow();
  });
});

describe('units', () => {
  test('namespaces are optional; conversions to US units', () => {
    expect(bareUnit('wmoUnit:km_h-1')).toBe('km_h-1');
    expect(bareUnit('degC')).toBe('degC');
    expect(converter('temperature', 'wmoUnit:degC')(100)).toBeCloseTo(212);
    expect(converter('temperature', 'wmoUnit:K')(273.15)).toBeCloseTo(32);
    expect(converter('speed', 'wmoUnit:km_h-1')(16.09344)).toBeCloseTo(10);
    expect(converter('speed', 'wmoUnit:m_s-1')(10)).toBeCloseTo(22.369, 2);
    expect(converter('speed', 'wmoUnit:kt')(10)).toBeCloseTo(11.508, 2);
    expect(converter('precipitation', 'wmoUnit:mm')(25.4)).toBeCloseTo(1);
    expect(converter('height', 'wmoUnit:m')(304.8)).toBeCloseTo(1000);
    expect(converter('percent', undefined)(42)).toBe(42);
  });

  test('an unknown unit is an error, never a guess', () => {
    expect(() => converter('speed', 'wmoUnit:furlong_fortnight-1')).toThrow(NwsUnitError);
    expect(() => converter('temperature', undefined)).toThrow(NwsUnitError);
  });
});

function grid(props: Partial<NwsGridpoint['properties']> = {}): NwsGridpoint {
  return nwsGridpointSchema.parse({
    type: 'Feature',
    geometry: null,
    properties: {
      updateTime: '2026-10-29T11:42:31+00:00',
      gridId: 'DTX',
      gridX: 31,
      gridY: 40,
      ...props,
    },
  });
}

describe('gridpoint layers -> hourly rows', () => {
  test('a level holds for every hour of its interval; an amount is spread evenly', () => {
    const g = grid({
      windSpeed: {
        uom: 'wmoUnit:km_h-1',
        values: [
          { validTime: '2026-10-29T12:00:00+00:00/PT2H', value: 16.09344 },
          { validTime: '2026-10-29T14:00:00+00:00/PT1H', value: 32.18688 },
        ],
      },
      quantitativePrecipitation: {
        uom: 'wmoUnit:mm',
        values: [{ validTime: '2026-10-29T12:00:00+00:00/PT6H', value: 7.62 }],
      },
    });
    const wind = expandLayer('windSpeed', g.properties.windSpeed);
    expect([...wind.entries()]).toEqual([
      [T0, expect.closeTo(10, 6)],
      [T0 + H, expect.closeTo(10, 6)],
      [T0 + 2 * H, expect.closeTo(20, 6)],
    ]);
    const issue = mapGridpoint(g);
    expect(issue.grid).toEqual({ id: 'DTX/31,40', wfo: 'DTX', x: 31, y: 40 });
    expect(issue.issuedAt).toBe('2026-10-29T11:42:31.000Z');
    expect(issue.hours).toHaveLength(6);
    expect(issue.hours.map((h) => h.qpfIn)).toEqual([0.05, 0.05, 0.05, 0.05, 0.05, 0.05]);
    expect(issue.hours[2]).toMatchObject({ validAt: '2026-10-29T14:00:00.000Z', windMph: 20 });
    // Layers the grid lacks are null (e.g. no windGust, transportWindSpeed).
    expect(issue.hours[0]).toMatchObject({ gustMph: null, transportWindMph: null, tempF: null });
    expect(issue.hours[5]).toMatchObject({ windMph: null, qpfIn: 0.05 });
  });

  test('hours ascend without duplicates; a window trims them; null values stay null', () => {
    const g = grid({
      windGust: {
        uom: 'wmoUnit:km_h-1',
        values: [
          { validTime: '2026-10-29T14:00:00+00:00/PT2H', value: null },
          { validTime: '2026-10-29T12:00:00+00:00/PT2H', value: 24.14016 },
        ],
      },
      relativeHumidity: {
        uom: 'wmoUnit:percent',
        values: [{ validTime: '2026-10-29T12:00:00+00:00/PT4H', value: 104 }],
      },
      windDirection: {
        uom: 'wmoUnit:degree_(angle)',
        values: [{ validTime: '2026-10-29T12:00:00+00:00/PT4H', value: 370 }],
      },
    });
    const issue = mapGridpoint(g, { from: T0 + H, to: T0 + 3 * H });
    expect(issue.hours.map((h) => h.validAt)).toEqual([
      '2026-10-29T13:00:00.000Z',
      '2026-10-29T14:00:00.000Z',
    ]);
    expect(issue.hours[0]).toMatchObject({ gustMph: 15, rhPct: 100, windDir: 10 });
    expect(issue.hours[1]?.gustMph).toBeNull();
  });

  test('trimGridpoint keeps the used layers and the values overlapping the window', () => {
    const g = grid({
      temperature: {
        uom: 'wmoUnit:degC',
        values: [
          { validTime: '2026-10-29T06:00:00+00:00/PT6H', value: 5 },
          { validTime: '2026-10-29T12:00:00+00:00/PT6H', value: 10 },
          { validTime: '2026-10-30T12:00:00+00:00/PT6H', value: 8 },
        ],
      },
    });
    const t = trimGridpoint(g, { from: T0, to: T0 + 12 * H });
    expect(t.properties.temperature?.values.map((v) => v.value)).toEqual([10]);
    expect(t.properties.windSpeed).toBeUndefined();
    expect(nwsGridpointSchema.safeParse(t).success).toBe(true);
    // Deterministic: the same issue trims to the same bytes.
    expect(JSON.stringify(trimGridpoint(g, { from: T0, to: T0 + 12 * H }))).toBe(JSON.stringify(t));
  });
});

describe('stations and observations', () => {
  test('stations sort by distance from the point asked about', () => {
    const raw = {
      type: 'FeatureCollection' as const,
      features: [
        { id: 'KTOL', lng: -83.8078, lat: 41.5868 },
        { id: 'KADG', lng: -84.0773, lat: 41.8676 },
      ].map((s) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] as [number, number] },
        properties: { stationIdentifier: s.id, name: `${s.id} airport` },
      })),
    };
    expect(mapStations(raw).map((s) => s.id)).toEqual(['KTOL', 'KADG']);
    expect(mapStations(raw, { lng: -84.03, lat: 41.9 }).map((s) => s.id)).toEqual(['KADG', 'KTOL']);
  });

  test('an observation maps to US units; QC-missing values are null', () => {
    const raw = nwsObservationSchema.parse({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-84.0773, 41.8676] },
      properties: {
        station: 'https://api.weather.gov/stations/KADG',
        timestamp: '2026-10-29T11:53:00+00:00',
        temperature: { unitCode: 'wmoUnit:degC', value: 10, qualityControl: 'V' },
        dewpoint: { unitCode: 'wmoUnit:degC', value: 5, qualityControl: 'V' },
        windDirection: { unitCode: 'wmoUnit:degree_(angle)', value: 260, qualityControl: 'V' },
        windSpeed: { unitCode: 'wmoUnit:km_h-1', value: 16.09344, qualityControl: 'V' },
        windGust: { unitCode: 'wmoUnit:km_h-1', value: null, qualityControl: 'Z' },
        relativeHumidity: { unitCode: 'wmoUnit:percent', value: 71.3, qualityControl: 'V' },
        precipitationLastHour: { unitCode: 'wmoUnit:mm', value: 2.54, qualityControl: 'V' },
      },
    });
    expect(stationIdOf(raw)).toBe('KADG');
    expect(mapObservation(raw)).toEqual({
      stationId: 'KADG',
      stationName: null,
      observedAt: '2026-10-29T11:53:00.000Z',
      lng: -84.0773,
      lat: 41.8676,
      tempF: 50,
      dewpointF: 41,
      rhPct: 71,
      windMph: 10,
      gustMph: null,
      windDir: 260,
      precipLastHourIn: 0.1,
    });
  });
});
