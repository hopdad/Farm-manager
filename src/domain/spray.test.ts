import { describe, expect, test } from 'vitest';
import { assessSprayHour, countVerdicts, forecastStaleness, type SprayHourInput } from './spray';
import { sunAt, sunContext } from './spray-sun';
import {
  DEFAULT_SPRAY_THRESHOLDS,
  type HourlyForecast,
  SPRAY_RULES,
  type SprayReasonCode,
  type SprayThresholds,
  type SprayVerdict,
  sprayRulesVersion,
} from './weather';

const ADRIAN = { lng: -84.04, lat: 41.9 };
/** 2026-06-09 18:00 UTC = 14:00 EDT: mid-afternoon, far from sunrise and sunset. */
const AFTERNOON = '2026-06-09T18:00:00.000Z';
const H = 3_600_000;

function hour(validAt: string, v: Partial<HourlyForecast> = {}): HourlyForecast {
  return {
    validAt,
    tempF: 70,
    dewpointF: 55,
    rhPct: 59,
    windMph: 6,
    gustMph: 9,
    windDir: 220,
    popPct: 5,
    qpfIn: 0,
    skyPct: 40,
    mixingHeightFt: 4000,
    transportWindMph: 12,
    ...v,
  };
}

/** The hour plus 6 dry hours after it (overrides by offset). */
function forecast(
  forHour: string,
  at: Partial<HourlyForecast>,
  later: Record<number, Partial<HourlyForecast>> = {},
) {
  const t = Date.parse(forHour);
  return [0, 1, 2, 3, 4, 5, 6].map((k) =>
    hour(new Date(t + k * H).toISOString(), k === 0 ? at : (later[k] ?? {})),
  );
}

function input(
  forHour: string,
  hours: HourlyForecast[],
  extra: Partial<SprayHourInput> = {},
): SprayHourInput {
  return {
    forHour,
    location: ADRIAN,
    gridId: 'DTX/64,40',
    forecastIssuedAt: new Date(Date.parse(forHour) - 30 * 60_000).toISOString(),
    forecastCheckedAt: new Date(Date.parse(forHour) - 25 * 60_000).toISOString(),
    hours,
    now: new Date(Date.parse(forHour) - 20 * 60_000),
    ...extra,
  };
}

interface Row {
  name: string;
  forHour?: string;
  at?: Partial<HourlyForecast>;
  later?: Record<number, Partial<HourlyForecast>>;
  t?: Partial<SprayThresholds>;
  extra?: Partial<SprayHourInput>;
  verdict: SprayVerdict;
  codes: SprayReasonCode[];
}

// Defaults: wind no-go > 10, caution > 8, too calm < 3, gusts > 15, rain-free 4 h (PoP >= 50 or
// QPF >= 0.01 -> no-go), inversion: wind < 3, sky <= 30, within 2 h of sunrise/sunset or night.
const TABLE: Row[] = [
  { name: 'light breeze, dry, afternoon', verdict: 'go', codes: [] },
  { name: 'exactly at the caution line', at: { windMph: 8 }, verdict: 'go', codes: [] },
  { name: 'just above caution', at: { windMph: 8.5 }, verdict: 'caution', codes: ['wind_caution'] },
  {
    name: 'exactly at the limit',
    at: { windMph: 10, gustMph: 14 },
    verdict: 'caution',
    codes: ['wind_caution'],
  },
  {
    name: 'over the limit',
    at: { windMph: 12, gustMph: 14 },
    verdict: 'no_go',
    codes: ['wind_high'],
  },
  {
    name: 'too calm by day',
    at: { windMph: 2, skyPct: 60 },
    verdict: 'caution',
    codes: ['wind_low'],
  },
  { name: 'exactly the minimum', at: { windMph: 3 }, verdict: 'go', codes: [] },
  { name: 'gusty', at: { windMph: 7, gustMph: 18 }, verdict: 'no_go', codes: ['gust_high'] },
  { name: 'gust at the limit', at: { gustMph: 15 }, verdict: 'go', codes: [] },
  { name: 'no gust layer', at: { gustMph: null }, verdict: 'go', codes: [] },
  {
    name: 'wind and gusts both',
    at: { windMph: 16, gustMph: 25 },
    verdict: 'no_go',
    codes: ['wind_high', 'gust_high'],
  },
  {
    name: 'rain this hour',
    at: { popPct: 70, qpfIn: 0.05 },
    verdict: 'no_go',
    codes: ['rain_expected'],
  },
  { name: 'rain in 3 h', later: { 3: { popPct: 60 } }, verdict: 'no_go', codes: ['rain_expected'] },
  {
    name: 'rain in 4 h (the window end)',
    later: { 4: { qpfIn: 0.02 } },
    verdict: 'no_go',
    codes: ['rain_expected'],
  },
  {
    name: 'rain in 5 h is outside the window',
    later: { 5: { popPct: 90 } },
    verdict: 'go',
    codes: [],
  },
  { name: 'PoP below 50', later: { 2: { popPct: 40 } }, verdict: 'go', codes: [] },
  {
    name: 'rain as caution when Derrick says so',
    later: { 1: { popPct: 80 } },
    t: { rainVerdict: 'caution' },
    verdict: 'caution',
    codes: ['rain_expected'],
  },
  {
    name: 'calm clear dawn: too calm + inversion',
    forHour: '2026-06-09T10:00:00.000Z', // 06:00 EDT, ~sunrise
    at: { windMph: 1.5, skyPct: 5 },
    verdict: 'caution',
    codes: ['wind_low', 'inversion_risk'],
  },
  {
    name: 'calm clear night',
    forHour: '2026-06-10T05:00:00.000Z', // 01:00 EDT
    at: { windMph: 2, skyPct: 10 },
    verdict: 'caution',
    codes: ['wind_low', 'inversion_risk'],
  },
  {
    name: 'calm but cloudy dawn: no inversion',
    forHour: '2026-06-09T10:00:00.000Z',
    at: { windMph: 2, skyPct: 80 },
    verdict: 'caution',
    codes: ['wind_low'],
  },
  {
    name: 'calm clear midday: no inversion',
    at: { windMph: 2, skyPct: 0 },
    verdict: 'caution',
    codes: ['wind_low'],
  },
  {
    name: 'inversion as no-go when Derrick says so',
    forHour: '2026-06-10T01:00:00.000Z', // 21:00 EDT, ~sunset
    at: { windMph: 2, skyPct: 0 },
    t: { inversionVerdict: 'no_go' },
    verdict: 'no_go',
    codes: ['wind_low', 'inversion_risk'],
  },
  {
    name: 'stale forecast (not checked for 3 h)',
    extra: { now: new Date(Date.parse(AFTERNOON) + 3 * H) },
    verdict: 'caution',
    codes: ['forecast_stale'],
  },
  {
    name: 'an issue hours old, checked just now',
    extra: {
      forecastIssuedAt: new Date(Date.parse(AFTERNOON) - 6 * H).toISOString(),
      forecastCheckedAt: new Date(Date.parse(AFTERNOON) - 21 * 60_000).toISOString(),
    },
    verdict: 'go',
    codes: [],
  },
  { name: 'no wind layer', at: { windMph: null }, verdict: 'caution', codes: ['no_forecast'] },
  {
    name: 'no forecast issue at all',
    extra: { forecastIssuedAt: null, hours: [] },
    verdict: 'caution',
    codes: ['no_forecast'],
  },
  {
    name: 'hour missing from the issue',
    extra: { hours: [hour('2026-06-09T19:00:00.000Z')] },
    verdict: 'caution',
    codes: ['no_forecast'],
  },
];

describe('spray go/no-go v0.1 (default thresholds unless the row says)', () => {
  test.each(TABLE)('$name -> $verdict', (row) => {
    const forHour = row.forHour ?? AFTERNOON;
    const t = { ...DEFAULT_SPRAY_THRESHOLDS, ...row.t };
    const r = assessSprayHour(
      input(forHour, forecast(forHour, row.at ?? {}, row.later), row.extra),
      t,
    );
    expect(r.reasons.map((x) => x.code).sort()).toEqual([...row.codes].sort());
    expect(r.verdict).toBe(row.verdict);
    for (const reason of r.reasons) expect(reason.message.length).toBeGreaterThan(5);
  });

  test('inputs hold every value the rules read, the thresholds and the version', () => {
    const at = { windMph: 12, gustMph: 18 };
    const r = assessSprayHour(input(AFTERNOON, forecast(AFTERNOON, at)), DEFAULT_SPRAY_THRESHOLDS);
    expect(r.inputs).toMatchObject({
      rules: SPRAY_RULES,
      rulesVersion: sprayRulesVersion(DEFAULT_SPRAY_THRESHOLDS),
      forHour: AFTERNOON,
      gridId: 'DTX/64,40',
      forecastAgeMinutes: 10,
      forecastCheckedAt: '2026-06-09T17:35:00.000Z',
      hour: { windMph: 12, gustMph: 18, skyPct: 40, popPct: 5 },
      thresholds: DEFAULT_SPRAY_THRESHOLDS,
    });
    expect(r.inputs.rainWindow).toHaveLength(5);
    expect(r.inputs.sun.night).toBe(false);
    expect(r.reasons.find((x) => x.code === 'wind_high')).toMatchObject({
      message: 'Wind 12 mph (limit 10)',
      value: 12,
      threshold: 10,
    });
    // JSON round trip (stored as jsonb).
    expect(JSON.parse(JSON.stringify(r.inputs))).toEqual(r.inputs);
  });

  test('forHour must be a whole UTC hour', () => {
    expect(() =>
      assessSprayHour(input('2026-06-09T18:30:00.000Z', []), DEFAULT_SPRAY_THRESHOLDS),
    ).toThrow(/whole UTC hour/);
  });

  test('countVerdicts', () => {
    expect(countVerdicts(['go', 'go', 'caution', 'no_go'])).toEqual({ go: 2, caution: 1, noGo: 1 });
  });
});

describe('forecast staleness: from the last NWS check, and an 18 h issue-age backstop', () => {
  /** 13:40 EDT, 20 min before the assessed hour. */
  const now = new Date(Date.parse(AFTERNOON) - 20 * 60_000);
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const assess = (issuedAt: string, checkedAt: string | null) =>
    assessSprayHour(
      input(AFTERNOON, forecast(AFTERNOON, {}), {
        forecastIssuedAt: issuedAt,
        forecastCheckedAt: checkedAt,
        now,
      }),
      DEFAULT_SPRAY_THRESHOLDS,
    );
  const notChecked = (minutes: number, hours: number) => ({
    code: 'forecast_stale',
    verdict: 'caution',
    message: `Forecast not checked for ${hours} h (NWS unreachable)`,
    value: minutes,
    threshold: 120,
  });

  test('an issue 283 min old that NWS served again 5 min ago is current (live NWS)', () => {
    expect(forecastStaleness(ago(283), ago(5), now)).toBeNull();
    const r = assess(ago(283), ago(5));
    expect(r).toMatchObject({ verdict: 'go', reasons: [] });
    expect(r.inputs).toMatchObject({ forecastAgeMinutes: 283, forecastCheckedAt: ago(5) });
  });

  test('the same issue last checked 3 h ago: not checked (NWS unreachable)', () => {
    expect(forecastStaleness(ago(283), ago(180), now)).toEqual(notChecked(180, 3));
    const r = assess(ago(283), ago(180));
    expect(r.verdict).toBe('caution');
    expect(r.reasons).toEqual([notChecked(180, 3)]);
  });

  test('an issue 19 h old checked just now: NWS stopped updating the cell', () => {
    const old = {
      code: 'forecast_stale',
      verdict: 'caution',
      message: 'NWS forecast is 19 h old',
      value: 19 * 60,
      threshold: 18 * 60,
    };
    expect(forecastStaleness(ago(19 * 60), ago(0), now)).toEqual(old);
    expect(assess(ago(19 * 60), ago(0)).reasons).toEqual([old]);
  });

  test('both at once: one reason, the not-checked one', () => {
    expect(assess(ago(20 * 60), ago(180)).reasons).toEqual([notChecked(180, 3)]);
  });

  test('checkedAt unknown (null) counts from the issue time, as v0 did', () => {
    expect(forecastStaleness(ago(119), null, now)).toBeNull();
    expect(forecastStaleness(ago(180), null, now)).toEqual({
      code: 'forecast_stale',
      verdict: 'caution',
      message: 'Forecast is 3 h old',
      value: 180,
      threshold: 120,
    });
    expect(assess(ago(283), null).reasons.map((x) => x.code)).toEqual(['forecast_stale']);
  });

  test('the limits themselves are current; a check before the issue counts from the issue', () => {
    expect(forecastStaleness(ago(120), ago(120), now)).toBeNull();
    expect(forecastStaleness(ago(121), ago(121), now)?.value).toBe(121);
    expect(forecastStaleness(ago(18 * 60), ago(1), now)).toBeNull();
    expect(forecastStaleness(ago(18 * 60 + 1), ago(1), now)?.message).toBe(
      'NWS forecast is 18 h old',
    );
    expect(forecastStaleness(ago(60), ago(300), now)).toBeNull();
    // No issue at all: no_forecast covers it.
    expect(forecastStaleness(null, ago(5), now)).toBeNull();
  });
});

describe('sun times (inversion heuristic)', () => {
  const near = (iso: string | null, expectIso: string, minutes = 8) =>
    expect(Math.abs(Date.parse(iso ?? '') - Date.parse(expectIso)) / 60_000).toBeLessThan(minutes);

  test('Adrian, MI on Jun 9: sunrise about 6:00 EDT, sunset about 9:13 EDT', () => {
    const s = sunContext(Date.parse('2026-06-09T16:00:00Z'), ADRIAN.lat, ADRIAN.lng);
    near(s.sunrise, '2026-06-09T10:00:00Z');
    near(s.sunset, '2026-06-10T01:13:00Z');
    expect(s.night).toBe(false);
  });

  test('Adrian, MI on Dec 21: sunrise about 8:05 EST, sunset about 5:08 EST', () => {
    const s = sunContext(Date.parse('2026-12-21T17:00:00Z'), ADRIAN.lat, ADRIAN.lng);
    near(s.sunrise, '2026-12-21T13:05:00Z', 10);
    near(s.sunset, '2026-12-21T22:08:00Z', 10);
  });

  test('night and the distance to the nearest event', () => {
    const night = sunContext(Date.parse('2026-06-10T06:00:00Z'), ADRIAN.lat, ADRIAN.lng);
    expect(night.night).toBe(true);
    const dawn = sunContext(Date.parse('2026-06-09T10:30:00Z'), ADRIAN.lat, ADRIAN.lng);
    expect(dawn.night).toBe(false);
    expect(dawn.minutesToEvent).toBeLessThan(40);
    expect(sunAt(Date.parse('2026-06-09T10:00:00Z'), 89.9, 0).sunrise).toBeNull();
  });
});
