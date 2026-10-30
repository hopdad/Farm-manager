/**
 * Spray go/no-go v0.1 (plan 1b, pulled forward from Phase 2): pure rules over one forecast hour
 * and the D4 thresholds (src/domain/weather.ts). ADVISORY: the app says what the forecast and
 * the thresholds imply; the applicator decides (labels, the field, the licence).
 *
 * For field F and hour H (whole UTC hour), from the newest forecast issue of F's grid cell:
 *   no forecast for H                         -> no_forecast   (caution; nothing else checked)
 *   stale (`forecastStaleness`): not confirmed with NWS for 120 min, counted from the later of
 *     the issue time and the job's last good fetch of the cell; else an issue older than 18 h
 *                                             -> forecast_stale (caution)
 *   sustained wind > windMaxMph               -> wind_high     (no-go)
 *                  > windCautionMph           -> wind_caution  (caution)
 *                  < windMinMph               -> wind_low      (caution: drift travels in still air)
 *   wind not forecast                         -> no_forecast   (caution)
 *   gusts > gustMaxMph                        -> gust_high     (no-go)
 *   rain in H or the rainFreeHours after it   -> rain_expected (rainVerdict)
 *     (an hour is rain when PoP >= rainPopPct or QPF >= rainQpfIn)
 *   inversion heuristic: wind < inversionWindMph, sky cover <= inversionMaxSkyPct, and the
 *     hour's middle at night or within inversionSunHours of sunrise/sunset
 *                                             -> inversion_risk (inversionVerdict)
 * The verdict is the worst reason's ('go' when none). Every value a rule read is returned in
 * `inputs` (stored in farm.spray_assessments.inputs: the audit never depends on forecast rows),
 * with the thresholds and the rules version.
 */
import { sunContext } from './spray-sun';
import {
  FORECAST_ISSUE_MAX_AGE_MINUTES,
  type HourlyForecast,
  SPRAY_RULES,
  type SprayAssessmentView,
  type SprayReason,
  type SprayThresholds,
  type SprayVerdict,
  sprayRulesVersion,
  WEATHER_STALE_MINUTES,
  worstVerdict,
} from './weather';

const HOUR_MS = 3_600_000;

/** What one assessment needs. */
export interface SprayHourInput {
  /** Start of the hour (UTC ISO, whole hour). */
  forHour: string;
  /** Where the field is (a point inside its boundary): the sun's times depend on it. */
  location: { lng: number; lat: number };
  gridId: string | null;
  /** The forecast issue used (null: none for this field's cell). */
  forecastIssuedAt: string | null;
  /** The cell's last good NWS fetch (farm.weather_grids.forecast_checked_at; null: unknown). */
  forecastCheckedAt: string | null;
  /** That issue's hours (any order; at least H and the rain window when available). */
  hours: readonly HourlyForecast[];
  /** When the assessment is made (staleness). */
  now: Date;
}

/** One forecast hour as the rules read it (stored in `inputs`). */
export type SprayHourValues = Omit<HourlyForecast, 'validAt'>;

/** farm.spray_assessments.inputs. */
export interface SprayInputs {
  rules: string;
  rulesVersion: string;
  thresholds: SprayThresholds;
  forHour: string;
  location: { lng: number; lat: number };
  gridId: string | null;
  forecastIssuedAt: string | null;
  /** The issue's age at the assessment (minutes). */
  forecastAgeMinutes: number | null;
  /** The cell's last good NWS fetch as the assessment saw it (null: unknown). */
  forecastCheckedAt: string | null;
  /** The hour's forecast (null: not in the issue). */
  hour: SprayHourValues | null;
  /** PoP and QPF of H and the rainFreeHours after it, as far as the issue reaches. */
  rainWindow: { validAt: string; popPct: number | null; qpfIn: number | null }[];
  sun: {
    sunrise: string | null;
    sunset: string | null;
    night: boolean;
    minutesToEvent: number | null;
  };
}

export interface SprayAssessment {
  verdict: SprayVerdict;
  reasons: SprayReason[];
  inputs: SprayInputs;
}

const mphText = (v: number) => `${Math.round(v)} mph`;
const inText = (v: number) => `${v.toFixed(2)} in`;

function hourValues(h: HourlyForecast): SprayHourValues {
  return {
    tempF: h.tempF,
    dewpointF: h.dewpointF,
    rhPct: h.rhPct,
    windMph: h.windMph,
    gustMph: h.gustMph,
    windDir: h.windDir,
    popPct: h.popPct,
    qpfIn: h.qpfIn,
    skyPct: h.skyPct,
    mixingHeightFt: h.mixingHeightFt,
    transportWindMph: h.transportWindMph,
  };
}

/**
 * Is the forecast stale at `now`? The one rule the assessment, the views (`withStaleness`) and
 * the strip all use. A forecast is current as of the later of its issue time and `checkedAt`,
 * the weather.nws job's last successful fetch of its cell (NWS answered, with a new issue or the
 * same one again):
 *  - not checked for more than WEATHER_STALE_MINUTES (NWS unreachable, or the job not running);
 *  - else an issue older than FORECAST_ISSUE_MAX_AGE_MINUTES (NWS stopped updating the cell).
 * checkedAt null (never recorded) counts from the issue time alone. Returns the one
 * `forecast_stale` reason, or null (also with no issue at all: no_forecast covers that).
 */
export function forecastStaleness(
  issuedAt: string | null,
  checkedAt: string | null,
  now: Date,
): SprayReason | null {
  if (issuedAt === null) return null;
  const issuedMs = Date.parse(issuedAt);
  const checkedMs = checkedAt === null ? Number.NaN : Date.parse(checkedAt);
  const minutesSince = (ms: number) => Math.round((now.getTime() - ms) / 60_000);
  const unchecked = minutesSince(
    Number.isFinite(checkedMs) ? Math.max(issuedMs, checkedMs) : issuedMs,
  );
  if (unchecked > WEATHER_STALE_MINUTES) {
    const h = Math.round(unchecked / 60);
    return {
      code: 'forecast_stale',
      verdict: 'caution',
      message:
        checkedAt === null
          ? `Forecast is ${h} h old`
          : `Forecast not checked for ${h} h (NWS unreachable)`,
      value: unchecked,
      threshold: WEATHER_STALE_MINUTES,
    };
  }
  const age = minutesSince(issuedMs);
  if (age > FORECAST_ISSUE_MAX_AGE_MINUTES) {
    return {
      code: 'forecast_stale',
      verdict: 'caution',
      message: `NWS forecast is ${Math.round(age / 60)} h old`,
      value: age,
      threshold: FORECAST_ISSUE_MAX_AGE_MINUTES,
    };
  }
  return null;
}

/** Assess one field-hour (see the header for the rules). */
export function assessSprayHour(input: SprayHourInput, t: SprayThresholds): SprayAssessment {
  const forMs = Date.parse(input.forHour);
  if (!Number.isFinite(forMs) || forMs % HOUR_MS !== 0) {
    throw new Error(`assessSprayHour: forHour must be a whole UTC hour, got ${input.forHour}`);
  }
  const byHour = new Map(input.hours.map((h) => [Date.parse(h.validAt), h]));
  const hour = byHour.get(forMs) ?? null;
  const ageMinutes =
    input.forecastIssuedAt === null
      ? null
      : Math.max(
          0,
          Math.round((input.now.getTime() - Date.parse(input.forecastIssuedAt)) / 60_000),
        );
  const sun = sunContext(forMs + HOUR_MS / 2, input.location.lat, input.location.lng);
  const rainWindow: SprayInputs['rainWindow'] = [];
  for (let k = 0; k <= t.rainFreeHours; k++) {
    const h = byHour.get(forMs + k * HOUR_MS);
    if (h) rainWindow.push({ validAt: h.validAt, popPct: h.popPct, qpfIn: h.qpfIn });
  }
  const inputs: SprayInputs = {
    rules: SPRAY_RULES,
    rulesVersion: sprayRulesVersion(t),
    thresholds: { ...t },
    forHour: new Date(forMs).toISOString(),
    location: { lng: input.location.lng, lat: input.location.lat },
    gridId: input.gridId,
    forecastIssuedAt: input.forecastIssuedAt,
    forecastAgeMinutes: ageMinutes,
    forecastCheckedAt: input.forecastCheckedAt,
    hour: hour ? hourValues(hour) : null,
    rainWindow,
    sun,
  };

  const reasons: SprayReason[] = [];
  if (!hour || input.forecastIssuedAt === null) {
    reasons.push({
      code: 'no_forecast',
      verdict: 'caution',
      message: 'No forecast for this hour: check conditions on site',
    });
    return { verdict: worstVerdict(reasons.map((r) => r.verdict)), reasons, inputs };
  }

  const stale = forecastStaleness(input.forecastIssuedAt, input.forecastCheckedAt, input.now);
  if (stale) reasons.push(stale);

  const wind = hour.windMph;
  if (wind === null) {
    reasons.push({
      code: 'no_forecast',
      verdict: 'caution',
      message: 'No wind forecast for this hour',
    });
  } else if (wind > t.windMaxMph) {
    reasons.push({
      code: 'wind_high',
      verdict: 'no_go',
      message: `Wind ${mphText(wind)} (limit ${t.windMaxMph})`,
      value: wind,
      threshold: t.windMaxMph,
    });
  } else if (wind > t.windCautionMph) {
    reasons.push({
      code: 'wind_caution',
      verdict: 'caution',
      message: `Wind ${mphText(wind)} (caution above ${t.windCautionMph})`,
      value: wind,
      threshold: t.windCautionMph,
    });
  } else if (wind < t.windMinMph) {
    reasons.push({
      code: 'wind_low',
      verdict: 'caution',
      message: `Wind ${mphText(wind)}: too calm (min ${t.windMinMph})`,
      value: wind,
      threshold: t.windMinMph,
    });
  }

  if (hour.gustMph !== null && hour.gustMph > t.gustMaxMph) {
    reasons.push({
      code: 'gust_high',
      verdict: 'no_go',
      message: `Gusts ${mphText(hour.gustMph)} (limit ${t.gustMaxMph})`,
      value: hour.gustMph,
      threshold: t.gustMaxMph,
    });
  }

  const wet = rainWindow.filter(
    (h) =>
      (h.popPct !== null && h.popPct >= t.rainPopPct) ||
      (h.qpfIn !== null && h.qpfIn >= t.rainQpfIn),
  );
  if (wet.length) {
    const maxPop = Math.max(...wet.map((h) => h.popPct ?? 0));
    const total = wet.reduce((s, h) => s + (h.qpfIn ?? 0), 0);
    const within = t.rainFreeHours === 0 ? 'this hour' : `within ${t.rainFreeHours} h`;
    reasons.push({
      code: 'rain_expected',
      verdict: t.rainVerdict,
      message: `Rain expected ${within} (${Math.round(maxPop)}%${total > 0 ? `, ${inText(total)}` : ''})`,
      value: maxPop,
      threshold: t.rainPopPct,
    });
  }

  const nearSun =
    sun.night || (sun.minutesToEvent !== null && sun.minutesToEvent <= t.inversionSunHours * 60);
  if (
    wind !== null &&
    wind < t.inversionWindMph &&
    hour.skyPct !== null &&
    hour.skyPct <= t.inversionMaxSkyPct &&
    nearSun
  ) {
    reasons.push({
      code: 'inversion_risk',
      verdict: t.inversionVerdict,
      message: `Inversion risk: ${mphText(wind)}, clear sky, ${sun.night ? 'at night' : 'near sunrise or sunset'}`,
      value: wind,
      threshold: t.inversionWindMph,
    });
  }

  return { verdict: worstVerdict(reasons.map((r) => r.verdict)), reasons, inputs };
}

/**
 * A stored assessment as shown now. Rows are keyed on (field, hour, rules, forecast issue), so
 * an hour first assessed while its forecast was current keeps that row while NWS is unreachable,
 * and an hour first assessed during an outage keeps its `forecast_stale` once the same issue is
 * confirmed again. Staleness belongs to the moment, so the views judge it at `now`
 * (`forecastStaleness` of the row's issue and the cell's last check): a stale forecast adds the
 * reason (caution), a current one drops a stored one. Nothing is stored: the audit shows what
 * was assessed when.
 */
export function withStaleness<T extends SprayAssessmentView>(view: T, now: Date): T {
  const stale = forecastStaleness(view.forecastIssuedAt, view.forecastCheckedAt, now);
  const stored = view.reasons.some((r) => r.code === 'forecast_stale');
  if (!stale && !stored) return view;
  if (!stored && stale) {
    return {
      ...view,
      verdict: worstVerdict([view.verdict, stale.verdict]),
      reasons: [...view.reasons, stale],
    };
  }
  // A stored reason: the verdict is the worst of the others plus the staleness now.
  const reasons = view.reasons.filter((r) => r.code !== 'forecast_stale');
  if (stale) reasons.push(stale);
  return { ...view, verdict: worstVerdict(reasons.map((r) => r.verdict)), reasons };
}

/** Fields per verdict. */
export function countVerdicts(verdicts: Iterable<SprayVerdict>): {
  go: number;
  caution: number;
  noGo: number;
} {
  const c = { go: 0, caution: 0, noGo: 0 };
  for (const v of verdicts) {
    if (v === 'go') c.go++;
    else if (v === 'caution') c.caution++;
    else c.noGo++;
  }
  return c;
}

/** Display labels (advisory wording). */
export const SPRAY_VERDICT_LABELS: Record<SprayVerdict, string> = {
  go: 'Go',
  caution: 'Caution',
  no_go: 'No-go',
};

/** The words every spray view shows while the D4 thresholds are the shipped defaults. */
export const SPRAY_ADVISORY_DEFAULTS_TEXT = "Advisory, defaults pending Derrick's values";
/** …and once Derrick saved his own. */
export const SPRAY_ADVISORY_TEXT = 'Advisory: check labels and conditions on site';
