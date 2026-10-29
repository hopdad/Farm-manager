/**
 * The NWS stand-in's control API (docs/contracts-m1.md §11), served at
 * `${VENDOR_SIM_URL}/_control/vendor/nws/weather` behind the stand-in's loopback/Origin/JSON
 * guard:
 *
 *   GET  /_control/vendor/nws/weather   -> NwsSimWeatherStatus
 *   POST /_control/vendor/nws/weather   NwsSimWeatherRequest -> NwsSimWeatherStatus
 *
 * `windMph` pins the sustained wind of every forecast hour and observation (the spray demo's
 * wind slider; gusts follow at 1.3x + 1); `pattern` replaces the scenario's default weather.
 * null clears either; a field left out keeps its value. Every change starts a new forecast
 * issue (its updateTime is the change time), so the weather.nws job's next run lands it and
 * re-assesses spray. Kept in the stand-in's state file; cleared by /_control/reset.
 *
 * Types and zod only (no server code): the app's /admin/spray imports this module.
 */
import { z } from 'zod';
import { SCENARIO_NAMES, type ScenarioName } from '../../types';

export const NWS_WEATHER_PATTERNS = [
  'calm',
  'windy-morning',
  'dawn-inversion',
  'overnight-rain',
] as const;
export type NwsWeatherPattern = (typeof NWS_WEATHER_PATTERNS)[number];

export const NWS_WEATHER_PATTERN_LABELS: Record<NwsWeatherPattern, string> = {
  calm: 'Calm',
  'windy-morning': 'Windy morning',
  'dawn-inversion': 'Dawn inversion',
  'overnight-rain': 'Overnight rain',
};

/** Highest wind the slider can pin, mph. */
export const NWS_MAX_SIM_WIND_MPH = 40;

/** Path of the control endpoint below VENDOR_SIM_URL. */
export const NWS_SIM_WEATHER_CONTROL_PATH = '/_control/vendor/nws/weather';

export const nwsSimWeatherRequestSchema = z.strictObject({
  pattern: z.enum(NWS_WEATHER_PATTERNS).nullable().optional(),
  windMph: z.number().min(0).max(NWS_MAX_SIM_WIND_MPH).nullable().optional(),
});
export type NwsSimWeatherRequest = z.infer<typeof nwsSimWeatherRequestSchema>;

/** The knobs kept in the stand-in's state (`state.vendors.nws`). */
export const nwsSimWeatherStateSchema = z.object({
  pattern: z.enum(NWS_WEATHER_PATTERNS).nullable(),
  windMph: z.number().min(0).max(NWS_MAX_SIM_WIND_MPH).nullable(),
  /** Wall time of the last change (UTC ISO, whole seconds). */
  changedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type NwsSimWeatherState = z.infer<typeof nwsSimWeatherStateSchema>;

export const EMPTY_NWS_SIM_WEATHER: NwsSimWeatherState = Object.freeze({
  pattern: null,
  windMph: null,
  changedAt: null,
});

export interface NwsSimWeatherStatus extends NwsSimWeatherState {
  scenario: ScenarioName;
  /** The scenario's own weather. */
  defaultPattern: NwsWeatherPattern;
  /** What is served now: the override, else the scenario's. */
  effectivePattern: NwsWeatherPattern;
  /** updateTime of the forecast issue served now. */
  issuedAt: string;
  simNow: string;
  /** The weather now at the first station (Adrian), US units, rounded. */
  sample: {
    stationId: string;
    tempF: number;
    windMph: number;
    gustMph: number;
    windDir: number;
    popPct: number;
    skyPct: number;
  };
}

export const nwsSimWeatherStatusSchema = nwsSimWeatherStateSchema.extend({
  scenario: z.enum(SCENARIO_NAMES),
  defaultPattern: z.enum(NWS_WEATHER_PATTERNS),
  effectivePattern: z.enum(NWS_WEATHER_PATTERNS),
  issuedAt: z.iso.datetime({ offset: true }),
  simNow: z.iso.datetime({ offset: true }),
  sample: z.object({
    stationId: z.string(),
    tempF: z.number(),
    windMph: z.number(),
    gustMph: z.number(),
    windDir: z.number(),
    popPct: z.number(),
    skyPct: z.number(),
  }),
}) satisfies z.ZodType<NwsSimWeatherStatus>;
