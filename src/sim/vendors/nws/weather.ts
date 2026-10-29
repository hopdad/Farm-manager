/**
 * The simulated farm's weather (plan §5 NWS row: "scenario fixtures (windy morning, dawn
 * inversion, overnight rain) for CI and offline use"): a pure function of the weather pattern,
 * the sim time and the grid cell, in US units. The NWS stand-in (./routes.ts) serves it as
 * api.weather.gov-shaped forecasts and observations, converted to NWS's SI units, so the live
 * connector's unit handling runs in sim mode too.
 *
 * Patterns (one day's shape, repeated every sim day; times are farm-local, America/Detroit):
 *  - calm            light SW wind (2-3 mph at night, 4-7 mph by day), few clouds, dry
 *  - windy-morning   spray-windy's day: 4-5 mph at dawn, then 16 mph gusting 25 from
 *                    SPRAY_WINDY_HOLD.from (09:50) until SPRAY_WINDY_HOLD.to (18:20), calm night
 *  - dawn-inversion  near-calm (1.5 mph), clear and humid from evening through 09:00, then a
 *                    light breeze
 *  - overnight-rain  rain 00:30-06:30 (PoP 85 %, ~0.1 in an hour), showers ending by 09:00,
 *                    breezy afternoon (8-10 mph), rain chances rising again in the evening
 * Each scenario has a default pattern (SCENARIO_WEATHER); the stand-in's control API overrides
 * the pattern and/or pins the sustained wind (the spray demo's wind slider).
 *
 * The sim's day shape follows its own clock: the "sun" here is time of day only (no astronomy),
 * while the app's spray rules use the real sun at the forecast's wall-clock hour.
 */
import { SPRAY_WINDY_HOLD } from '../../scenarios';
import { hhmm, localParts } from '../../time';
import type { ScenarioName } from '../../types';
import type { NwsWeatherPattern } from './control-types';

export type WeatherPattern = NwsWeatherPattern;

/** Each scenario's default weather. */
export const SCENARIO_WEATHER: Record<ScenarioName, WeatherPattern> = {
  'harvest-day': 'calm',
  breakdown: 'calm',
  'bad-morning': 'overnight-rain',
  'planting-day': 'dawn-inversion',
  'spray-windy': 'windy-morning',
  'winter-idle': 'calm',
};

/** Weather at one instant and place, US units (null: not reported). */
export interface SimWeather {
  tempF: number;
  dewpointF: number;
  rhPct: number;
  windMph: number;
  gustMph: number;
  /** Degrees the wind blows from. */
  windDir: number;
  popPct: number;
  /** Rain in the hour starting at this instant, inches. */
  qpfIn: number;
  skyPct: number;
  mixingHeightFt: number;
  transportWindMph: number;
}

export interface WeatherInputs {
  pattern: WeatherPattern;
  /** Grid cell (small deterministic variation per cell). */
  cell: { x: number; y: number };
  /** Pinned sustained wind (the wind slider), mph; null = the pattern's. */
  windMph: number | null;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));
/** 0 → 1 between minutes a and b of the day (smooth). */
const ramp = (m: number, a: number, b: number) => {
  const t = Math.min(1, Math.max(0, (m - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Stable small integer hash of a grid cell. */
function cellHash(x: number, y: number): number {
  let h = 2166136261;
  for (const v of [x, y]) {
    h ^= v & 0xffff;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Per-cell offsets: wind ±0.8 mph, temperature ±1 °F. */
export function cellOffsets(cell: { x: number; y: number }): { wind: number; temp: number } {
  const h = cellHash(cell.x, cell.y);
  return { wind: ((h % 9) - 4) * 0.2, temp: (((h >>> 8) % 5) - 2) * 0.5 };
}

/** Normal daily high for SE Michigan by day of year (°F): ~33 in mid January, ~83 in late July. */
function normalHighF(dayOfYear: number): number {
  return 58 + 25 * Math.cos((2 * Math.PI * (dayOfYear - 200)) / 365.25);
}

function dayOfYear(p: { y: number; m: number; d: number }): number {
  return Math.floor((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(p.y, 0, 1)) / 86_400_000) + 1;
}

/** Diurnal 0 (06:00 low) → 1 (15:00 high) → 0 (next 06:00). */
function diurnal(m: number): number {
  const min = 360;
  const max = 900;
  if (m >= min && m <= max) return (1 - Math.cos((Math.PI * (m - min)) / (max - min))) / 2;
  const since = m > max ? m - max : m + 1440 - max;
  return (1 + Math.cos((Math.PI * since) / (1440 - (max - min)))) / 2;
}

/** Relative humidity from temperature and dewpoint (Magnus formula), %. */
export function relativeHumidity(tempF: number, dewpointF: number): number {
  const c = ((tempF - 32) * 5) / 9;
  const d = ((dewpointF - 32) * 5) / 9;
  const es = (t: number) => Math.exp((17.625 * t) / (243.04 + t));
  return Math.min(100, Math.max(0, (100 * es(d)) / es(c)));
}

interface Shape {
  windMph: number;
  gustExtra: number;
  windDir: number;
  skyPct: number;
  popPct: number;
  qpfIn: number;
  /** Dewpoint depression, °F. */
  spreadF: number;
  /** Shift of the day's high/low (cloud and rain damp the range). */
  highAdj: number;
  lowAdj: number;
  mixingHeightFt: number;
}

const DAY_START = hhmm('07:00');
const DAY_END = hhmm('20:00');

function daytimeMixing(m: number): number {
  if (m < DAY_START || m > DAY_END) return 600;
  return 1500 + 3500 * Math.sin((Math.PI * (m - DAY_START)) / (DAY_END - DAY_START));
}

function calm(m: number): Shape {
  const day = m >= hhmm('07:30') && m <= hhmm('19:30');
  const wind = day
    ? 4 + 3 * Math.sin((Math.PI * (m - hhmm('07:30'))) / (hhmm('19:30') - hhmm('07:30')))
    : 2.5;
  return {
    windMph: wind,
    gustExtra: day ? 3 : 1,
    windDir: 205,
    skyPct: day ? 20 : 10,
    popPct: 3,
    qpfIn: 0,
    spreadF: lerp(4, 15, diurnal(m)),
    highAdj: 0,
    lowAdj: 0,
    mixingHeightFt: daytimeMixing(m),
  };
}

function windyMorning(m: number): Shape {
  const up = hhmm(SPRAY_WINDY_HOLD.from);
  const down = hhmm(SPRAY_WINDY_HOLD.to);
  let wind: number;
  if (m < up - 30) wind = lerp(2.5, 4.5, ramp(m, hhmm('05:00'), hhmm('08:30')));
  else if (m < up) wind = lerp(4.5, 16, ramp(m, up - 30, up));
  else if (m <= down) wind = 16;
  else wind = lerp(16, 3, ramp(m, down, down + 120));
  const gusty = m >= up && m <= down;
  return {
    windMph: wind,
    gustExtra: gusty ? 9 : 2,
    windDir: gusty ? 290 : 240,
    skyPct: gusty ? 40 : 20,
    popPct: 8,
    qpfIn: 0,
    spreadF: lerp(5, 18, diurnal(m)),
    highAdj: 1,
    lowAdj: 0,
    mixingHeightFt: daytimeMixing(m) + (gusty ? 1500 : 0),
  };
}

function dawnInversion(m: number): Shape {
  const breezy = m >= hhmm('09:30') && m <= hhmm('18:30');
  let wind: number;
  if (m < hhmm('09:00')) wind = 1.5;
  else if (m < hhmm('09:30')) wind = lerp(1.5, 5, ramp(m, hhmm('09:00'), hhmm('09:30')));
  else if (breezy) wind = 5 + 2 * Math.sin((Math.PI * (m - hhmm('09:30'))) / 540);
  else wind = lerp(5, 1.5, ramp(m, hhmm('18:30'), hhmm('21:00')));
  return {
    windMph: wind,
    gustExtra: breezy ? 3 : 0.5,
    windDir: 160,
    skyPct: breezy ? 15 : 5,
    popPct: 2,
    qpfIn: 0,
    spreadF: breezy ? lerp(6, 14, diurnal(m)) : 1.5,
    highAdj: 2,
    lowAdj: -3,
    mixingHeightFt: breezy ? daytimeMixing(m) : 300,
  };
}

function overnightRain(m: number): Shape {
  const rainFrom = hhmm('00:30');
  const rainTo = hhmm('06:30');
  if (m >= rainFrom && m < rainTo) {
    const peak = 1 - Math.abs((m - hhmm('03:30')) / 180);
    return {
      windMph: 9,
      gustExtra: 7,
      windDir: 140,
      skyPct: 100,
      popPct: 85,
      qpfIn: 0.06 + 0.06 * Math.max(0, peak),
      spreadF: 1,
      highAdj: -6,
      lowAdj: 4,
      mixingHeightFt: 1500,
    };
  }
  if (m >= rainTo && m < hhmm('09:00')) {
    const t = ramp(m, rainTo, hhmm('09:00'));
    return {
      windMph: lerp(9, 7, t),
      gustExtra: 6,
      windDir: 200,
      skyPct: lerp(90, 60, t),
      popPct: lerp(45, 15, t),
      qpfIn: lerp(0.02, 0, t),
      spreadF: lerp(1.5, 5, t),
      highAdj: -6,
      lowAdj: 4,
      mixingHeightFt: 1800,
    };
  }
  // Breezy afternoon; rain chances build again from 21:00 towards the next night's rain.
  const evening = ramp(m, hhmm('21:00'), hhmm('23:59'));
  const day = m >= hhmm('09:00') && m < hhmm('19:00');
  return {
    windMph: day ? 8 + 2 * Math.sin((Math.PI * (m - hhmm('09:00'))) / 600) : 6,
    gustExtra: day ? 7 : 4,
    windDir: day ? 250 : 170,
    skyPct: lerp(60, 95, evening),
    popPct: lerp(10, 70, evening),
    qpfIn: 0,
    spreadF: lerp(6, 3, evening),
    highAdj: -6,
    lowAdj: 4,
    mixingHeightFt: daytimeMixing(m),
  };
}

const SHAPES: Record<WeatherPattern, (minuteOfDay: number) => Shape> = {
  calm,
  'windy-morning': windyMorning,
  'dawn-inversion': dawnInversion,
  'overnight-rain': overnightRain,
};

/** The weather at sim instant `simMs` for a pattern and grid cell. */
export function simWeatherAt(simMs: number, inputs: WeatherInputs): SimWeather {
  const p = localParts(simMs);
  const s = SHAPES[inputs.pattern](p.minuteOfDay);
  const off = cellOffsets(inputs.cell);
  const high = normalHighF(dayOfYear(p)) + s.highAdj;
  const low = high - 19 + s.lowAdj;
  const tempF = lerp(low, high, diurnal(p.minuteOfDay)) + off.temp;
  const dewpointF = tempF - s.spreadF;
  let windMph: number;
  let gustMph: number;
  if (inputs.windMph !== null) {
    windMph = Math.max(0, inputs.windMph + off.wind);
    gustMph = windMph * 1.3 + 1;
  } else {
    windMph = s.windMph > 1 ? Math.max(0, s.windMph + off.wind) : s.windMph;
    gustMph = windMph + s.gustExtra;
  }
  return {
    tempF,
    dewpointF,
    rhPct: relativeHumidity(tempF, dewpointF),
    windMph,
    gustMph,
    windDir: s.windDir,
    popPct: s.popPct,
    qpfIn: s.qpfIn,
    skyPct: s.skyPct,
    mixingHeightFt: s.mixingHeightFt,
    transportWindMph: windMph * 1.5 + 2,
  };
}
