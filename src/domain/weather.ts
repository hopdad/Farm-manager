/**
 * Weather and spray go/no-go contract (plan 1b; docs/contracts-m1.md §5).
 *
 *  - What the NWS connector produces (`HourlyForecast`, `ForecastIssue`, `Observation`) and
 *    stores in farm.weather_forecasts / farm.weather_observations.
 *  - What the weather strip renders (`WeatherStrip`, built on the server, sent as JSON).
 *  - Spray go/no-go v0: `SprayVerdict` with stored reasons (farm.spray_assessments), and the
 *    thresholds (D4) kept in app.settings 'spray.thresholds' with the defaults below.
 *
 * The rules engine (forecast hours + thresholds -> verdict) is the weather builder's, in
 * src/domain/spray*.ts. Pure TS + zod: the server, the jobs and the browser all import this.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// NWS grid cells
// ---------------------------------------------------------------------------------------------

/** A forecast grid cell: `/gridpoints/{wfo}/{x},{y}` (farm.weather_grids.id = '<wfo>/<x>,<y>'). */
export interface GridRef {
  /** '<wfo>/<x>,<y>', e.g. 'DTX/31,40'. */
  id: string;
  /** Weather forecast office (NWS `gridId`), e.g. 'DTX'. */
  wfo: string;
  x: number;
  y: number;
}

const GRID_ID_RE = /^([A-Z]{3})\/(\d{1,4}),(\d{1,4})$/;

/** farm.weather_grids.id for a cell (the database CHECKs the same format). */
export function gridId(wfo: string, x: number, y: number): string {
  const id = `${wfo}/${x},${y}`;
  if (!GRID_ID_RE.test(id)) throw new Error(`bad NWS grid cell: ${id}`);
  return id;
}

/** Parse '<wfo>/<x>,<y>'; null when malformed. */
export function parseGridId(id: string): GridRef | null {
  const m = GRID_ID_RE.exec(id);
  if (!m) return null;
  return { id, wfo: m[1] as string, x: Number(m[2]), y: Number(m[3]) };
}

/** One observation station near a grid cell (farm.weather_grids.stations, nearest first). */
export interface WeatherStation {
  /** ICAO-style id, e.g. 'KADG'. */
  id: string;
  name: string | null;
  lng: number;
  lat: number;
}

// ---------------------------------------------------------------------------------------------
// Forecasts and observations (connector output; one row each in the farm.weather_* tables)
// ---------------------------------------------------------------------------------------------

/**
 * One forecast hour. Units are US customary (the connector converts NWS's SI values).
 * null = the grid didn't carry that layer for this hour (e.g. no `windGust`).
 */
export interface HourlyForecast {
  /** Start of the hour, UTC ISO-8601 (farm.weather_forecasts.valid_at). */
  validAt: string;
  tempF: number | null;
  dewpointF: number | null;
  rhPct: number | null;
  /** Sustained wind. */
  windMph: number | null;
  gustMph: number | null;
  /** Degrees the wind blows FROM, [0, 360]. */
  windDir: number | null;
  /** Probability of precipitation. */
  popPct: number | null;
  /** Quantitative precipitation forecast for the hour, inches. */
  qpfIn: number | null;
  /** Sky cover. */
  skyPct: number | null;
  mixingHeightFt: number | null;
  transportWindMph: number | null;
}

/** One NWS forecast issue for one grid cell. */
export interface ForecastIssue {
  grid: GridRef;
  /** NWS `updateTime` (farm.weather_forecasts.issued_at). */
  issuedAt: string;
  /** Ascending by validAt, one per hour, no duplicates. */
  hours: HourlyForecast[];
}

/** A station observation (farm.weather_observations). */
export interface Observation {
  stationId: string;
  stationName: string | null;
  observedAt: string;
  lng: number | null;
  lat: number | null;
  tempF: number | null;
  dewpointF: number | null;
  rhPct: number | null;
  windMph: number | null;
  gustMph: number | null;
  windDir: number | null;
  precipLastHourIn: number | null;
}

/**
 * A forecast not confirmed with NWS for longer than this is stale (`forecast_stale`, the strip's
 * badge). It counts from the later of the issue time and the weather.nws job's last successful
 * fetch of the cell (farm.weather_grids.forecast_checked_at), not from the issue time alone: live
 * NWS often keeps one `updateTime` for hours. The job runs every 30 min.
 */
export const WEATHER_STALE_MINUTES = 120;

/**
 * An issue older than this is stale even while NWS still serves it: a backstop for a cell NWS
 * stopped updating (it updates every grid at least twice a day).
 */
export const FORECAST_ISSUE_MAX_AGE_MINUTES = 18 * 60;

// ---------------------------------------------------------------------------------------------
// The weather strip (view model; built on the server, rendered by src/ui/weather)
// ---------------------------------------------------------------------------------------------

/** One day on the strip (America/Detroit calendar day). */
export interface WeatherStripDay {
  /** YYYY-MM-DD, local (America/Detroit). */
  date: string;
  /** 'Today', 'Tue', … */
  label: string;
  highF: number | null;
  lowF: number | null;
  /** Sum of qpfIn over the day's hours. */
  rainIn: number | null;
  maxPopPct: number | null;
  maxWindMph: number | null;
  maxGustMph: number | null;
}

/** One hour on the strip's detail row. */
export interface WeatherStripHour extends HourlyForecast {
  /**
   * The spray verdict for this hour on the strip's reference field, when assessed: null past the
   * stored window (the current hour + SPRAY_ASSESS_AHEAD_HOURS).
   */
  spray: SprayVerdict | null;
}

/** The latest soil temperature reading, shown with its age (1b: manual probe readings). */
export interface SoilTempView {
  tempF: number;
  depthIn: number;
  observedAt: string;
  /** Whole minutes between observedAt and the strip's `builtAt`. */
  ageMinutes: number;
  source: 'manual' | 'station' | 'probe';
  fieldId: string | null;
  fieldName: string | null;
}

export interface WeatherStrip {
  /** When the server built this view (UTC ISO). */
  builtAt: string;
  /** The grid cell shown: the one most fields share (null before the first lookup). */
  grid: GridRef | null;
  issuedAt: string | null;
  /**
   * When the forecast was last confirmed with NWS: the job's last successful fetch of the cell
   * (a new issue or the same one again), else when the newest issue was stored.
   */
  fetchedAt: string | null;
  /**
   * No forecast at all, or `forecastStaleness` (src/domain/spray.ts) says stale: not checked
   * for WEATHER_STALE_MINUTES, or an issue older than FORECAST_ISSUE_MAX_AGE_MINUTES.
   */
  stale: boolean;
  /** CONNECTOR_WEATHER at build time ('sim' shows a "simulated weather" badge). */
  mode: 'sim' | 'replay' | 'sandbox' | 'live' | 'off';
  /** Latest observation at the grid's nearest reporting station. */
  now: Observation | null;
  /** Today plus the next 3 days (4 entries when the forecast reaches that far). */
  days: WeatherStripDay[];
  /** From the current hour, up to 36 hours. */
  hours: WeatherStripHour[];
  soilTemp: SoilTempView | null;
  /** Fields per verdict for the current hour (null before the first assessment). */
  spray: { forHour: string; go: number; caution: number; noGo: number } | null;
}

// ---------------------------------------------------------------------------------------------
// Spray go/no-go v0 (advisory; D4 sets the thresholds)
// ---------------------------------------------------------------------------------------------

export const SPRAY_VERDICTS = ['go', 'caution', 'no_go'] as const;
export type SprayVerdict = (typeof SPRAY_VERDICTS)[number];

/** Worst first: the overall verdict is the worst of the reasons' verdicts ('go' if none). */
export function worstVerdict(verdicts: Iterable<SprayVerdict>): SprayVerdict {
  let worst: SprayVerdict = 'go';
  for (const v of verdicts) {
    if (v === 'no_go') return 'no_go';
    if (v === 'caution') worst = 'caution';
  }
  return worst;
}

/** Why a verdict isn't plain 'go'. Stable codes: stored in farm.spray_assessments.reasons. */
export const SPRAY_REASON_CODES = [
  'wind_high',
  'wind_caution',
  'wind_low',
  'gust_high',
  'rain_expected',
  'inversion_risk',
  'no_forecast',
  'forecast_stale',
] as const;
export type SprayReasonCode = (typeof SPRAY_REASON_CODES)[number];

export interface SprayReason {
  code: SprayReasonCode;
  /** What this reason alone implies. */
  verdict: Exclude<SprayVerdict, 'go'>;
  /** One short sentence for the crew, e.g. 'Gusts 18 mph (limit 15)'. */
  message: string;
  /** The measured or forecast value the rule compared, in the threshold's unit. */
  value?: number | null;
  threshold?: number | null;
}

/**
 * Spray thresholds (D4). DEFAULTS PENDING DERRICK'S VALUES: the software only enforces them;
 * Derrick sets them from the labels and his licence on /admin/spray. All advisory.
 */
export interface SprayThresholds {
  /** Sustained wind above this: no-go. */
  windMaxMph: number;
  /** Sustained wind above this (and at most windMaxMph): caution. */
  windCautionMph: number;
  /** Sustained wind below this: caution (drift can travel far in still air; inversion sign). */
  windMinMph: number;
  /** Gusts above this: no-go. */
  gustMaxMph: number;
  /** Rain expected within this many hours after the spray hour: rain_expected. */
  rainFreeHours: number;
  /** An hour counts as rain when popPct >= this … */
  rainPopPct: number;
  /** … or qpfIn >= this. */
  rainQpfIn: number;
  /** Verdict when rain is expected inside rainFreeHours. */
  rainVerdict: 'caution' | 'no_go';
  /** Inversion heuristic: wind below this … */
  inversionWindMph: number;
  /** … and sky cover at most this (clear sky) … */
  inversionMaxSkyPct: number;
  /** … within this many hours of sunrise or sunset (or at night). */
  inversionSunHours: number;
  /** Verdict when the inversion heuristic fires. */
  inversionVerdict: 'caution' | 'no_go';
}

/** Common-label starting points; NOT Derrick's values (D4 is open). */
export const DEFAULT_SPRAY_THRESHOLDS: SprayThresholds = Object.freeze({
  windMaxMph: 10,
  windCautionMph: 8,
  windMinMph: 3,
  gustMaxMph: 15,
  rainFreeHours: 4,
  rainPopPct: 50,
  rainQpfIn: 0.01,
  rainVerdict: 'no_go',
  inversionWindMph: 3,
  inversionMaxSkyPct: 30,
  inversionSunHours: 2,
  inversionVerdict: 'caution',
});

const mph = z.number().min(0).max(100);
export const sprayThresholdsSchema = z
  .strictObject({
    windMaxMph: mph,
    windCautionMph: mph,
    windMinMph: mph,
    gustMaxMph: mph,
    rainFreeHours: z.number().int().min(0).max(48),
    rainPopPct: z.number().min(0).max(100),
    rainQpfIn: z.number().min(0).max(5),
    rainVerdict: z.enum(['caution', 'no_go']),
    inversionWindMph: mph,
    inversionMaxSkyPct: z.number().min(0).max(100),
    inversionSunHours: z.number().min(0).max(6),
    inversionVerdict: z.enum(['caution', 'no_go']),
  })
  .refine((t) => t.windMinMph <= t.windCautionMph && t.windCautionMph <= t.windMaxMph, {
    message: 'need windMinMph <= windCautionMph <= windMaxMph',
  }) satisfies z.ZodType<SprayThresholds>;

/** app.settings key holding the thresholds (value: SprayThresholdsSetting). */
export const SPRAY_THRESHOLDS_SETTING_KEY = 'spray.thresholds';

/** The stored setting: the thresholds plus whether they are still the shipped defaults. */
export interface SprayThresholdsSetting {
  thresholds: SprayThresholds;
  /**
   * True until someone saves values on /admin/spray. The UI then says "advisory, defaults
   * pending Derrick's values".
   */
  isDefault: boolean;
  updatedAt: string | null;
  /** Display name of the app user who saved them. */
  updatedBy: string | null;
}

export const sprayThresholdsSettingSchema = z.strictObject({
  thresholds: sprayThresholdsSchema,
  isDefault: z.boolean(),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
  updatedBy: z.string().min(1).nullable(),
}) satisfies z.ZodType<SprayThresholdsSetting>;

export function defaultSprayThresholdsSetting(): SprayThresholdsSetting {
  return {
    thresholds: { ...DEFAULT_SPRAY_THRESHOLDS },
    isDefault: true,
    updatedAt: null,
    updatedBy: null,
  };
}

/**
 * Read the stored setting. A missing or invalid value means the defaults (readers treat a
 * missing app.settings key as its default, contracts §4).
 */
export function parseSprayThresholdsSetting(value: unknown): SprayThresholdsSetting {
  const r = sprayThresholdsSettingSchema.safeParse(value);
  return r.success ? r.data : defaultSprayThresholdsSetting();
}

/**
 * Bump when the RULES change (not the thresholds: those are hashed into the version).
 * v0.1: forecast staleness counts from the last NWS check, plus the 18 h issue-age backstop.
 */
export const SPRAY_RULES = 'v0.1';

/**
 * farm.spray_assessments.rules_version: the rules generation plus a hash of the thresholds,
 * e.g. 'v0.1-1a2b3c4d'. Equal inputs give equal versions, so a re-run is a no-op (unique key).
 */
export function sprayRulesVersion(t: SprayThresholds, rules: string = SPRAY_RULES): string {
  const keys = Object.keys(t).sort() as (keyof SprayThresholds)[];
  const text = keys.map((k) => `${k}=${String(t[k])}`).join(';');
  return `${rules}-${fnv1a32(text)}`;
}

/** FNV-1a 32-bit as 8 hex digits (pure; runs in the browser too). */
function fnv1a32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** One stored assessment as the UI shows it (a farm.spray_assessments row). */
export interface SprayAssessmentView {
  fieldId: string;
  /** Start of the assessed hour, UTC ISO. */
  forHour: string;
  verdict: SprayVerdict;
  reasons: SprayReason[];
  rulesVersion: string;
  forecastIssuedAt: string | null;
  /**
   * The cell's farm.weather_grids.forecast_checked_at at read time (not stored per row): with
   * forecastIssuedAt, what `withStaleness` judges. Null: never recorded, or no cell.
   */
  forecastCheckedAt: string | null;
  assessedAt: string;
}

// ---------------------------------------------------------------------------------------------
// Stored assessments and retention (docs/contracts-m1.md §3.1, §13). The weather.nws job
// assesses only these hours and prunes both tables, so they stay bounded at 500 fields.
// ---------------------------------------------------------------------------------------------

/** Each weather.nws run stores, per field, the current hour plus this many hours after it. */
export const SPRAY_ASSESS_AHEAD_HOURS = 12;

/**
 * farm.weather_forecasts rows of issues older than this (by issued_at) are deleted, except the
 * (grid, issue, hour) rows a stored assessment used (grid_id, forecast_issued_at, for_hour).
 */
export const FORECAST_RETENTION_HOURS = 48;

/**
 * farm.spray_assessments rows whose for_hour is older than this many days are deleted, except the
 * newest one (by assessed_at, then id) per (field_id, for_hour): what the farm was told last.
 */
export const SPRAY_DETAIL_RETENTION_DAYS = 30;

const HOUR_MS = 3_600_000;

/**
 * The hours a run assesses: the start of `now`'s hour (UTC; Michigan's offsets are whole hours),
 * then each of the next `ahead` hours, as UTC ISO strings (farm.spray_assessments.for_hour).
 */
export function sprayAssessmentHours(
  now: Date,
  ahead: number = SPRAY_ASSESS_AHEAD_HOURS,
): string[] {
  const t = now.getTime();
  if (!Number.isFinite(t)) throw new Error('sprayAssessmentHours: invalid date');
  if (!Number.isInteger(ahead) || ahead < 0) throw new Error(`bad hours ahead: ${ahead}`);
  const start = Math.floor(t / HOUR_MS) * HOUR_MS;
  return Array.from({ length: ahead + 1 }, (_, i) => new Date(start + i * HOUR_MS).toISOString());
}
