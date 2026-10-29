/**
 * Pure mapping of api.weather.gov responses to the app's weather contract
 * (src/domain/weather.ts): SI -> US customary, ISO 8601 intervals -> one row per UTC hour.
 *
 * Gridpoint layers (OpenAPI `GridpointQuantitativeValueLayer`) carry run-length values: each
 * `validTime` is an interval ('2026-10-29T14:00:00+00:00/PT3H') and the value holds for every
 * hour it covers. Two kinds:
 *  - levels (temperature, wind, sky cover, PoP, mixing height, …): the value applies to each
 *    covered hour;
 *  - amounts (quantitativePrecipitation): the value is the total over the interval, spread
 *    evenly over its hours (a 6-hour 0.30 in becomes 0.05 in an hour; doc-derived, confirm).
 * An hour is covered when its start lies in [floor_hour(start), end).
 */
import type {
  ForecastIssue,
  GridRef,
  HourlyForecast,
  Observation,
  WeatherStation,
} from '../../domain/weather';
import { gridId } from '../../domain/weather';
import {
  NWS_GRID_LAYERS,
  type NwsGridLayer,
  type NwsGridLayerName,
  type NwsGridpoint,
  type NwsObservation,
  type NwsPoint,
  type NwsQuantitativeValue,
  type NwsStationCollection,
} from './schemas';
import { clampPct, converter, normalizeDir, type Quantity, round } from './units';

const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------------------------
// ISO 8601 intervals
// ---------------------------------------------------------------------------------------------

interface Duration {
  years: number;
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

const DURATION_RE =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

export function parseIsoDuration(text: string): Duration {
  const m = DURATION_RE.exec(text);
  if (!m || text === 'P' || text.endsWith('T')) throw new Error(`bad ISO 8601 duration: ${text}`);
  const n = (i: number) => (m[i] ? Number(m[i]) : 0);
  return {
    years: n(1),
    months: n(2),
    weeks: n(3),
    days: n(4),
    hours: n(5),
    minutes: n(6),
    seconds: n(7),
  };
}

/** `ms` plus (sign 1) or minus (sign -1) a duration; years and months on the UTC calendar. */
function addDuration(ms: number, d: Duration, sign: 1 | -1): number {
  const t = new Date(ms);
  if (d.years || d.months) t.setUTCMonth(t.getUTCMonth() + sign * (d.years * 12 + d.months));
  const fixed =
    ((d.weeks * 7 + d.days) * 24 * 3600 + d.hours * 3600 + d.minutes * 60 + d.seconds) * 1000;
  return t.getTime() + sign * fixed;
}

/** Parse an interval: start/end, start/duration or duration/end (UTC ms, end exclusive). */
export function parseValidTime(validTime: string): { start: number; end: number } {
  const [a, b] = validTime.split('/');
  if (!a || !b) throw new Error(`bad ISO 8601 interval: ${validTime}`);
  const isDur = (s: string) => s.startsWith('P');
  let start: number;
  let end: number;
  if (!isDur(a) && !isDur(b)) {
    start = Date.parse(a);
    end = Date.parse(b);
  } else if (!isDur(a)) {
    start = Date.parse(a);
    end = addDuration(start, parseIsoDuration(b), 1);
  } else if (!isDur(b)) {
    end = Date.parse(b);
    start = addDuration(end, parseIsoDuration(a), -1);
  } else {
    throw new Error(`bad ISO 8601 interval (two durations): ${validTime}`);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error(`bad ISO 8601 interval: ${validTime}`);
  }
  return { start, end };
}

/** Hour starts (UTC ms) an interval covers. */
function coveredHours(start: number, end: number): number[] {
  const out: number[] = [];
  for (let h = Math.floor(start / HOUR_MS) * HOUR_MS; h < end; h += HOUR_MS) out.push(h);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Gridpoint layers -> hourly values
// ---------------------------------------------------------------------------------------------

interface LayerSpec {
  quantity: Quantity;
  kind: 'level' | 'amount';
  digits: number;
}

const LAYER_SPECS: Record<NwsGridLayerName, LayerSpec> = {
  temperature: { quantity: 'temperature', kind: 'level', digits: 1 },
  dewpoint: { quantity: 'temperature', kind: 'level', digits: 1 },
  relativeHumidity: { quantity: 'percent', kind: 'level', digits: 0 },
  windSpeed: { quantity: 'speed', kind: 'level', digits: 1 },
  windGust: { quantity: 'speed', kind: 'level', digits: 1 },
  windDirection: { quantity: 'angle', kind: 'level', digits: 0 },
  probabilityOfPrecipitation: { quantity: 'percent', kind: 'level', digits: 0 },
  quantitativePrecipitation: { quantity: 'precipitation', kind: 'amount', digits: 3 },
  skyCover: { quantity: 'percent', kind: 'level', digits: 0 },
  mixingHeight: { quantity: 'height', kind: 'level', digits: 0 },
  transportWindSpeed: { quantity: 'speed', kind: 'level', digits: 1 },
};

/** One layer as hour start (UTC ms) -> value in app units (null = the layer says null). */
export function expandLayer(
  name: NwsGridLayerName,
  layer: NwsGridLayer | undefined,
): Map<number, number | null> {
  const out = new Map<number, number | null>();
  if (!layer) return out;
  const spec = LAYER_SPECS[name];
  const convert = converter(spec.quantity, layer.uom);
  for (const v of layer.values) {
    const { start, end } = parseValidTime(v.validTime);
    const hours = coveredHours(start, end);
    for (const h of hours) {
      if (v.value === null) {
        out.set(h, null);
        continue;
      }
      const value = spec.kind === 'amount' ? convert(v.value) / hours.length : convert(v.value);
      out.set(h, value);
    }
  }
  return out;
}

const COLUMN: Record<NwsGridLayerName, keyof Omit<HourlyForecast, 'validAt'>> = {
  temperature: 'tempF',
  dewpoint: 'dewpointF',
  relativeHumidity: 'rhPct',
  windSpeed: 'windMph',
  windGust: 'gustMph',
  windDirection: 'windDir',
  probabilityOfPrecipitation: 'popPct',
  quantitativePrecipitation: 'qpfIn',
  skyCover: 'skyPct',
  mixingHeight: 'mixingHeightFt',
  transportWindSpeed: 'transportWindMph',
};

export interface HourWindow {
  /** First hour kept (UTC ms, inclusive). */
  from?: number;
  /** End (UTC ms, exclusive). */
  to?: number;
}

/** The grid cell a gridpoint answer describes. */
export function gridOfGridpoint(raw: NwsGridpoint): GridRef {
  const p = raw.properties;
  return { id: gridId(p.gridId, p.gridX, p.gridY), wfo: p.gridId, x: p.gridX, y: p.gridY };
}

/**
 * A /gridpoints answer -> one ForecastIssue: `issuedAt` = updateTime, one HourlyForecast per
 * UTC hour any used layer covers (inside `window`), ascending; a layer the grid lacks (e.g. no
 * windGust or transportWindSpeed) is null in every hour.
 */
export function mapGridpoint(raw: NwsGridpoint, window: HourWindow = {}): ForecastIssue {
  const expanded = NWS_GRID_LAYERS.map(
    (name) => [name, expandLayer(name, raw.properties[name])] as const,
  );
  const hours = new Set<number>();
  for (const [, m] of expanded) for (const h of m.keys()) hours.add(h);
  const from = window.from ?? Number.NEGATIVE_INFINITY;
  const to = window.to ?? Number.POSITIVE_INFINITY;
  const sorted = [...hours].filter((h) => h >= from && h < to).sort((a, b) => a - b);
  const rows: HourlyForecast[] = sorted.map((h) => {
    const row: HourlyForecast = {
      validAt: new Date(h).toISOString(),
      tempF: null,
      dewpointF: null,
      rhPct: null,
      windMph: null,
      gustMph: null,
      windDir: null,
      popPct: null,
      qpfIn: null,
      skyPct: null,
      mixingHeightFt: null,
      transportWindMph: null,
    };
    for (const [name, m] of expanded) {
      const v = m.get(h);
      if (v === undefined || v === null) continue;
      const spec = LAYER_SPECS[name];
      let value = round(v, spec.digits);
      if (spec.quantity === 'percent') value = clampPct(value);
      if (spec.quantity === 'angle') value = normalizeDir(value);
      if (
        spec.quantity === 'speed' ||
        spec.quantity === 'precipitation' ||
        spec.quantity === 'height'
      ) {
        value = value === null ? null : Math.max(0, value);
      }
      row[COLUMN[name]] = value;
    }
    return row;
  });
  return {
    grid: gridOfGridpoint(raw),
    issuedAt: new Date(Date.parse(raw.properties.updateTime)).toISOString(),
    hours: rows,
  };
}

/**
 * The part of a /gridpoints answer worth landing in ingest.raw_events: the layers the app uses,
 * and only the values that overlap `window`. Deterministic for one issue (pass a window derived
 * from updateTime), so re-polling the same issue lands nothing new (sha256 dedupe).
 */
export function trimGridpoint(raw: NwsGridpoint, window: HourWindow): NwsGridpoint {
  const from = window.from ?? Number.NEGATIVE_INFINITY;
  const to = window.to ?? Number.POSITIVE_INFINITY;
  const p = raw.properties;
  const props: NwsGridpoint['properties'] = {
    updateTime: p.updateTime,
    ...(p.validTimes ? { validTimes: p.validTimes } : {}),
    gridId: p.gridId,
    gridX: p.gridX,
    gridY: p.gridY,
  };
  for (const name of NWS_GRID_LAYERS) {
    const layer = p[name];
    if (!layer) continue;
    props[name] = {
      ...(layer.uom ? { uom: layer.uom } : {}),
      values: layer.values.filter((v) => {
        const { start, end } = parseValidTime(v.validTime);
        return end > from && start < to;
      }),
    };
  }
  return { type: 'Feature', geometry: raw.geometry ?? null, properties: props };
}

// ---------------------------------------------------------------------------------------------
// Points, stations, observations
// ---------------------------------------------------------------------------------------------

/** The grid cell a /points answer names. */
export function gridOfPoint(raw: NwsPoint): GridRef {
  const p = raw.properties;
  return { id: gridId(p.gridId, p.gridX, p.gridY), wfo: p.gridId, x: p.gridX, y: p.gridY };
}

/** Great-circle distance in metres (haversine). */
export function distanceM(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): number {
  const R = 6_371_008.8;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Stations of a grid cell, nearest to `near` first (we sort ourselves rather than rely on the
 * API's order). Without `near` the API's order is kept.
 */
export function mapStations(
  raw: NwsStationCollection,
  near?: { lng: number; lat: number },
): WeatherStation[] {
  const out = raw.features.map((f) => ({
    id: f.properties.stationIdentifier,
    name: f.properties.name ?? null,
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));
  if (!near) return out;
  return out
    .map((s, i) => ({ s, i, d: distanceM(near, s) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.s);
}

/** The station id of an observation: `stationId`, else the last segment of `station`. */
export function stationIdOf(raw: NwsObservation, fallback?: string): string {
  const p = raw.properties;
  if (p.stationId) return p.stationId;
  const tail = p.station?.split('/').filter(Boolean).pop();
  if (tail) return tail;
  if (fallback) return fallback;
  throw new Error('NWS observation without a station');
}

function qvIn(
  q: NwsQuantitativeValue | null | undefined,
  quantity: Quantity,
  digits: number,
): number | null {
  if (!q || q.value === null || q.value === undefined) return null;
  return round(converter(quantity, q.unitCode)(q.value), digits);
}

/** One observation -> the app's Observation (US units). */
export function mapObservation(raw: NwsObservation, fallbackStationId?: string): Observation {
  const p = raw.properties;
  const coords = raw.geometry?.coordinates;
  const speed = (q: NwsQuantitativeValue | null | undefined) => {
    const v = qvIn(q, 'speed', 1);
    return v === null ? null : Math.max(0, v);
  };
  const precip = qvIn(p.precipitationLastHour, 'precipitation', 3);
  return {
    stationId: stationIdOf(raw, fallbackStationId),
    stationName: p.stationName ?? null,
    observedAt: new Date(Date.parse(p.timestamp)).toISOString(),
    lng: coords ? coords[0] : null,
    lat: coords ? coords[1] : null,
    tempF: qvIn(p.temperature, 'temperature', 1),
    dewpointF: qvIn(p.dewpoint, 'temperature', 1),
    rhPct: clampPct(qvIn(p.relativeHumidity, 'percent', 0)),
    windMph: speed(p.windSpeed),
    gustMph: speed(p.windGust),
    windDir: normalizeDir(qvIn(p.windDirection, 'angle', 0)),
    precipLastHourIn: precip === null ? null : Math.max(0, precip),
  };
}
