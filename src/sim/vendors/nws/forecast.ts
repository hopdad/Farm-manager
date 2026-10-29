/**
 * api.weather.gov-shaped bodies computed from the simulated weather (./weather.ts), in NWS's
 * own units (wmoUnit:degC, km_h-1, mm, m, percent, degree_(angle)) so the live connector's
 * conversions run in sim mode.
 *
 * FORECAST ISSUES. NWS updates a grid's forecast about hourly (`updateTime`). The stand-in
 * issues one per SIM hour: issue `IS` = the sim hour that started last; its wall time `IW` is
 * when the current clock segment reached (or would have reached) IS, so it is stable while the
 * segment lasts (a pause keeps it; a resume, speed change or jump starts a new issue). A change
 * of the control knobs (wind slider, pattern) also starts one: updateTime = max(IW, changedAt).
 * The issue's hours are wall-clock hours from floor_hour(IW) for 7 days; wall hour H shows the
 * sim weather at IS + (H - IW), i.e. forecast hours step one sim hour per hour whatever the sim
 * speed (at 30x the forecast still reads like a forecast, and a new issue lands every 2 min).
 *
 * OBSERVATIONS follow the time rule (contracts §9): an observation stamped at wall w reports
 * the weather at simAt(w), every 20 wall minutes.
 */
import type { ClockTimeline } from '../clock';
import { currentClock, simAt } from '../clock';
import type { NwsWeatherPattern } from './control-types';
import { type SimStation, simCellAt, simCellCenter, simCellPolygon } from './grid';
import { type SimWeather, simWeatherAt } from './weather';

const HOUR_MS = 3_600_000;
export const FORECAST_DAYS = 7;
export const OBSERVATION_STEP_MS = 20 * 60_000;

/** NWS writes instants with a +00:00 offset and whole seconds. */
export function nwsInstant(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', '+00:00');
}

export interface ForecastIssueClock {
  /** updateTime (ms, whole seconds). */
  updateMs: number;
  /** Wall instant the issue's sim hour maps to (hour mapping). */
  mapWallMs: number;
  /** The issue's sim hour (ms). */
  issueSimMs: number;
}

/** The issue served at `wallNow` (see the header). */
export function currentIssue(
  timeline: ClockTimeline,
  wallNow: Date,
  changedAt: string | null,
): ForecastIssueClock {
  const cur = currentClock(timeline);
  const simNow = simAt(timeline, wallNow).getTime();
  const issueSimMs = Math.floor(simNow / HOUR_MS) * HOUR_MS;
  const mapWallMs =
    Date.parse(cur.anchorWall) + (issueSimMs - Date.parse(cur.anchorSim)) / cur.speed;
  const changed = changedAt ? Date.parse(changedAt) : Number.NEGATIVE_INFINITY;
  const updateMs =
    Math.floor(Math.min(wallNow.getTime(), Math.max(mapWallMs, changed)) / 1000) * 1000;
  return { updateMs, mapWallMs, issueSimMs };
}

// ---------------------------------------------------------------------------------------------
// Units (US -> NWS SI)
// ---------------------------------------------------------------------------------------------

const toC = (f: number) => ((f - 32) * 5) / 9;
const toKmh = (mph: number) => mph * 1.609344;
const toMm = (inches: number) => inches * 25.4;
const toM = (ft: number) => ft * 0.3048;
const r = (v: number, digits: number) => {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
};

interface LayerValue {
  validTime: string;
  value: number | null;
}

/** Hourly values -> NWS run-length layer values (equal neighbours merged). */
function runLength(startMs: number, values: number[]): LayerValue[] {
  const out: LayerValue[] = [];
  let i = 0;
  while (i < values.length) {
    let j = i + 1;
    while (j < values.length && values[j] === values[i]) j++;
    out.push({
      validTime: `${nwsInstant(startMs + i * HOUR_MS)}/PT${j - i}H`,
      value: values[i] as number,
    });
    i = j;
  }
  return out;
}

/** Hourly amounts -> 6-hour totals aligned to 00/06/12/18 UTC (like NWS's QPF). */
function sixHourTotals(startMs: number, amounts: number[]): LayerValue[] {
  const out: LayerValue[] = [];
  let i = 0;
  while (i < amounts.length) {
    const t = startMs + i * HOUR_MS;
    const hourOfDay = new Date(t).getUTCHours();
    const len = Math.min(6 - (hourOfDay % 6), amounts.length - i);
    let sum = 0;
    for (let k = i; k < i + len; k++) sum += amounts[k] as number;
    out.push({ validTime: `${nwsInstant(t)}/PT${len}H`, value: r(sum, 2) });
    i += len;
  }
  return out;
}

export interface GridpointInputs {
  /** Absolute base of the stand-in's NWS root, e.g. http://127.0.0.1:4010/nws. */
  base: string;
  wfo: string;
  x: number;
  y: number;
  issue: ForecastIssueClock;
  pattern: NwsWeatherPattern;
  windMph: number | null;
}

/** GET /gridpoints/{wfo}/{x},{y} body. */
export function buildGridpoint(i: GridpointInputs): unknown {
  const startMs = Math.floor(i.issue.mapWallMs / HOUR_MS) * HOUR_MS;
  const hours = FORECAST_DAYS * 24;
  const wx: SimWeather[] = [];
  for (let k = 0; k < hours; k++) {
    const wallHour = startMs + k * HOUR_MS;
    const simMs = i.issue.issueSimMs + (wallHour - i.issue.mapWallMs);
    wx.push(
      simWeatherAt(simMs, { pattern: i.pattern, cell: { x: i.x, y: i.y }, windMph: i.windMph }),
    );
  }
  const layer = (uom: string, f: (w: SimWeather) => number) => ({
    uom,
    values: runLength(
      startMs,
      wx.map((w) => f(w)),
    ),
  });
  const id = `${i.base}/gridpoints/${i.wfo}/${i.x},${i.y}`;
  return {
    '@context': ['https://geojson.org/geojson-ld/geojson-context.jsonld'],
    id,
    type: 'Feature',
    geometry: simCellPolygon(i.x, i.y),
    properties: {
      '@id': id,
      '@type': 'wx:Gridpoint',
      updateTime: nwsInstant(i.issue.updateMs),
      validTimes: `${nwsInstant(startMs)}/P${FORECAST_DAYS}D`,
      elevation: { unitCode: 'wmoUnit:m', value: 240 },
      forecastOffice: `${i.base}/offices/${i.wfo}`,
      gridId: i.wfo,
      gridX: i.x,
      gridY: i.y,
      temperature: layer('wmoUnit:degC', (w) => r(toC(w.tempF), 2)),
      dewpoint: layer('wmoUnit:degC', (w) => r(toC(w.dewpointF), 2)),
      relativeHumidity: layer('wmoUnit:percent', (w) => Math.round(w.rhPct)),
      skyCover: layer('wmoUnit:percent', (w) => Math.round(w.skyPct)),
      windDirection: layer('wmoUnit:degree_(angle)', (w) => Math.round(w.windDir)),
      windSpeed: layer('wmoUnit:km_h-1', (w) => r(toKmh(w.windMph), 3)),
      windGust: layer('wmoUnit:km_h-1', (w) => r(toKmh(w.gustMph), 3)),
      probabilityOfPrecipitation: layer('wmoUnit:percent', (w) => Math.round(w.popPct)),
      quantitativePrecipitation: {
        uom: 'wmoUnit:mm',
        values: sixHourTotals(
          startMs,
          wx.map((w) => toMm(w.qpfIn)),
        ),
      },
      mixingHeight: layer('wmoUnit:m', (w) => Math.round(toM(w.mixingHeightFt))),
      transportWindSpeed: layer('wmoUnit:km_h-1', (w) => r(toKmh(w.transportWindMph), 3)),
    },
  };
}

/** GET /points/{lat},{lon} body (null outside the simulated office area). */
export function buildPoint(base: string, lat: number, lng: number): unknown | null {
  const cell = simCellAt(lng, lat);
  if (!cell) return null;
  const grid = `${base}/gridpoints/${cell.wfo}/${cell.x},${cell.y}`;
  const id = `${base}/points/${lat},${lng}`;
  return {
    '@context': ['https://geojson.org/geojson-ld/geojson-context.jsonld'],
    id,
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: {
      '@id': id,
      '@type': 'wx:Point',
      cwa: cell.wfo,
      forecastOffice: `${base}/offices/${cell.wfo}`,
      gridId: cell.wfo,
      gridX: cell.x,
      gridY: cell.y,
      forecast: `${grid}/forecast`,
      forecastHourly: `${grid}/forecast/hourly`,
      forecastGridData: grid,
      observationStations: `${grid}/stations`,
      timeZone: 'America/Detroit',
      radarStation: 'KDTX',
    },
  };
}

/** GET /gridpoints/{wfo}/{x},{y}/stations body: the stations nearest the cell first. */
export function buildStations(
  base: string,
  x: number,
  y: number,
  stations: readonly SimStation[],
  limit = stations.length,
): unknown {
  const c = simCellCenter(x, y);
  const d = (s: SimStation) =>
    Math.hypot((s.lng - c.lng) * Math.cos((c.lat * Math.PI) / 180), s.lat - c.lat);
  const sorted = [...stations].sort((a, b) => d(a) - d(b)).slice(0, limit);
  return {
    '@context': ['https://geojson.org/geojson-ld/geojson-context.jsonld'],
    type: 'FeatureCollection',
    features: sorted.map((s) => ({
      id: `${base}/stations/${s.id}`,
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      properties: {
        '@id': `${base}/stations/${s.id}`,
        '@type': 'wx:ObservationStation',
        elevation: { unitCode: 'wmoUnit:m', value: s.elevationM },
        stationIdentifier: s.id,
        name: s.name,
        timeZone: 'America/Detroit',
      },
    })),
    observationStations: sorted.map((s) => `${base}/stations/${s.id}`),
  };
}

export interface ObservationInputs {
  base: string;
  station: SimStation;
  wallMs: number;
  simMs: number;
  pattern: NwsWeatherPattern;
  windMph: number | null;
}

/** One observation Feature at wall instant `wallMs` (weather at sim instant `simMs`). */
export function buildObservation(i: ObservationInputs): unknown {
  const cell = simCellAt(i.station.lng, i.station.lat) ?? { x: 0, y: 0 };
  const w = simWeatherAt(i.simMs, { pattern: i.pattern, cell, windMph: i.windMph });
  const ts = nwsInstant(i.wallMs);
  const id = `${i.base}/stations/${i.station.id}/observations/${ts}`;
  const q = (unitCode: string, value: number | null) => ({ unitCode, value, qualityControl: 'V' });
  const gusty = w.gustMph - w.windMph >= 4;
  return {
    id,
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [i.station.lng, i.station.lat] },
    properties: {
      '@id': id,
      '@type': 'wx:ObservationStation',
      elevation: { unitCode: 'wmoUnit:m', value: i.station.elevationM },
      station: `${i.base}/stations/${i.station.id}`,
      stationId: i.station.id,
      stationName: i.station.name,
      timestamp: ts,
      textDescription: w.qpfIn > 0 ? 'Rain' : w.skyPct > 70 ? 'Cloudy' : 'Clear',
      temperature: q('wmoUnit:degC', r(toC(w.tempF), 1)),
      dewpoint: q('wmoUnit:degC', r(toC(w.dewpointF), 1)),
      windDirection: q('wmoUnit:degree_(angle)', Math.round(w.windDir / 10) * 10),
      windSpeed: q('wmoUnit:km_h-1', r(toKmh(w.windMph), 3)),
      windGust: q('wmoUnit:km_h-1', gusty ? r(toKmh(w.gustMph), 3) : null),
      relativeHumidity: q('wmoUnit:percent', r(w.rhPct, 2)),
      precipitationLastHour: q('wmoUnit:mm', r(toMm(w.qpfIn), 1)),
    },
  };
}

/** Observation instants of a station in (fromMs, toMs], newest first, on the 20-minute grid. */
export function observationInstants(fromMs: number, toMs: number, limit: number): number[] {
  const out: number[] = [];
  for (
    let t = Math.floor(toMs / OBSERVATION_STEP_MS) * OBSERVATION_STEP_MS;
    t > fromMs && out.length < limit;
    t -= OBSERVATION_STEP_MS
  ) {
    out.push(t);
  }
  return out;
}
