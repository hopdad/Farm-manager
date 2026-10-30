import { describe, expect, test } from 'vitest';
import { withStaleness } from '../../domain/spray';
import type { HourlyForecast, SprayAssessmentView, SprayReason } from '../../domain/weather';
import { buildWeatherStrip, localDate, type StripInputs } from './strip-model';

const H = 3_600_000;
/** 2026-10-29 14:20 EDT. */
const NOW = new Date('2026-10-29T18:20:00Z');

function hour(ms: number, v: Partial<HourlyForecast> = {}): HourlyForecast {
  return {
    validAt: new Date(ms).toISOString(),
    tempF: 50,
    dewpointF: 40,
    rhPct: 68,
    windMph: 6,
    gustMph: 10,
    windDir: 220,
    popPct: 10,
    qpfIn: 0,
    skyPct: 30,
    mixingHeightFt: 3000,
    transportWindMph: 12,
    ...v,
  };
}

/** Hourly forecast from 2026-10-29 04:00 UTC (00:00 EDT) for 6 days. */
const start = Date.parse('2026-10-29T04:00:00Z');
const hours = Array.from({ length: 6 * 24 }, (_, k) =>
  hour(start + k * H, {
    tempF: 40 + (k % 24),
    qpfIn: k === 30 ? 0.12 : k === 31 ? 0.08 : 0,
    popPct: k === 30 ? 80 : 10,
    gustMph: k === 20 ? 22 : 10,
  }),
);

function inputs(over: Partial<StripInputs> = {}): StripInputs {
  return {
    now: NOW,
    mode: 'sim',
    grid: { id: 'DTX/64,39', wfo: 'DTX', x: 64, y: 39 },
    issuedAt: new Date(NOW.getTime() - 40 * 60_000).toISOString(),
    fetchedAt: new Date(NOW.getTime() - 35 * 60_000).toISOString(),
    checkedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    hours,
    observation: null,
    soilTemp: null,
    verdicts: [],
    referenceVerdicts: new Map(),
    ...over,
  };
}

describe('weather strip view model', () => {
  test('today + 3 days in America/Detroit with highs, lows, rain, PoP and gusts', () => {
    const s = buildWeatherStrip(inputs());
    expect(s.days.map((d) => [d.date, d.label])).toEqual([
      ['2026-10-29', 'Today'],
      ['2026-10-30', 'Fri'],
      ['2026-10-31', 'Sat'],
      ['2026-11-01', 'Sun'],
    ]);
    expect(s.days[0]).toMatchObject({ highF: 63, lowF: 40, maxGustMph: 22, rainIn: 0 });
    expect(s.days[1]).toMatchObject({ rainIn: 0.2, maxPopPct: 80 });
  });

  test('hours start at the current hour (max 36) and carry the reference verdicts', () => {
    const forHour = '2026-10-29T18:00:00.000Z';
    const s = buildWeatherStrip(
      inputs({
        referenceVerdicts: new Map([[forHour, 'caution' as const]]),
        verdicts: ['go', 'go', 'no_go'],
      }),
    );
    expect(s.hours).toHaveLength(36);
    expect(s.hours[0]).toMatchObject({ validAt: forHour, spray: 'caution' });
    expect(s.hours[1]?.spray).toBeNull();
    expect(s.spray).toEqual({ forHour, go: 2, caution: 0, noGo: 1 });
    expect(s.stale).toBe(false);
    expect(s.builtAt).toBe(NOW.toISOString());
  });

  test('stale: not checked with NWS for 2 h, an issue over 18 h old, or no forecast at all', () => {
    const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
    // Live NWS: the issue is hours old, but the job fetched it again 5 min ago.
    const live = buildWeatherStrip(inputs({ issuedAt: ago(283), checkedAt: ago(5) }));
    expect(live).toMatchObject({ stale: false, issuedAt: ago(283), fetchedAt: ago(5) });
    // The same issue, last checked 3 h ago (NWS unreachable).
    expect(buildWeatherStrip(inputs({ issuedAt: ago(283), checkedAt: ago(180) })).stale).toBe(true);
    // Checked just now, but NWS hasn't updated the cell for 19 h.
    expect(buildWeatherStrip(inputs({ issuedAt: ago(19 * 60), checkedAt: ago(0) })).stale).toBe(
      true,
    );
    // Never checked (cells cached before forecast_checked_at existed): the issue's age decides,
    // and fetchedAt is when the issue was stored.
    const legacy = buildWeatherStrip(inputs({ issuedAt: ago(180), checkedAt: null }));
    expect(legacy).toMatchObject({ stale: true, fetchedAt: ago(35) });
    expect(buildWeatherStrip(inputs({ checkedAt: null })).stale).toBe(false);
    const none = buildWeatherStrip(
      inputs({ issuedAt: null, fetchedAt: null, checkedAt: ago(5), hours: [], grid: null }),
    );
    expect(none).toMatchObject({ stale: true, days: [], hours: [], spray: null });
    const soil = buildWeatherStrip(
      inputs({
        soilTemp: {
          tempF: 51,
          depthIn: 2,
          observedAt: new Date(NOW.getTime() - 125 * 60_000).toISOString(),
          source: 'manual',
          fieldId: null,
          fieldName: null,
        },
      }),
    ).soilTemp;
    expect(soil).toMatchObject({ tempF: 51, ageMinutes: 125 });
  });

  test('localDate follows daylight time', () => {
    expect(localDate(Date.parse('2026-11-01T04:30:00Z'))).toBe('2026-11-01'); // 00:30 EDT
    expect(localDate(Date.parse('2026-11-02T04:30:00Z'))).toBe('2026-11-01'); // 23:30 EST
  });
});

describe('views add staleness to stored verdicts', () => {
  const view: SprayAssessmentView = {
    fieldId: 'f',
    forHour: '2026-10-29T18:00:00.000Z',
    verdict: 'go',
    reasons: [],
    rulesVersion: 'v0.1-x',
    forecastIssuedAt: '2026-10-29T15:00:00.000Z',
    forecastCheckedAt: '2026-10-29T15:05:00.000Z',
    assessedAt: '2026-10-29T15:05:00.000Z',
  };
  test('not checked for over 120 min: caution with a reason; checked or no issue: unchanged', () => {
    const shown = withStaleness(view, NOW);
    expect(shown.verdict).toBe('caution');
    expect(shown.reasons.map((r) => r.message)).toEqual(['Forecast not checked with NWS for 3 h']);
    expect(withStaleness(view, new Date('2026-10-29T16:00:00Z'))).toBe(view);
    // The issue is 200 min old, but NWS served it again 5 min ago.
    expect(withStaleness({ ...view, forecastCheckedAt: '2026-10-29T18:15:00.000Z' }, NOW)).toEqual({
      ...view,
      forecastCheckedAt: '2026-10-29T18:15:00.000Z',
    });
    // Never checked: the issue's age, as before.
    expect(
      withStaleness({ ...view, forecastCheckedAt: null }, NOW).reasons.map((r) => r.message),
    ).toEqual(['Forecast is 3 h old']);
    expect(withStaleness({ ...view, forecastIssuedAt: null }, NOW).verdict).toBe('go');
    expect(withStaleness({ ...view, verdict: 'no_go' }, NOW).verdict).toBe('no_go');
  });

  test('a forecast_stale stored during an outage is dropped once NWS confirms the issue', () => {
    const wind: SprayReason = {
      code: 'wind_caution',
      verdict: 'caution',
      message: 'Wind 9 mph (caution above 8)',
    };
    const stored: SprayAssessmentView = {
      ...view,
      verdict: 'caution',
      reasons: [
        {
          code: 'forecast_stale',
          verdict: 'caution',
          message: 'Forecast not checked with NWS for 2 h',
          value: 125,
          threshold: 120,
        },
      ],
    };
    const confirmed = { ...stored, forecastCheckedAt: '2026-10-29T18:15:00.000Z' };
    expect(withStaleness(confirmed, NOW)).toMatchObject({ verdict: 'go', reasons: [] });
    expect(withStaleness({ ...confirmed, reasons: [wind, ...stored.reasons] }, NOW)).toMatchObject({
      verdict: 'caution',
      reasons: [wind],
    });
    // Still unreachable: one reason, as of now.
    const still = withStaleness({ ...stored, reasons: [wind, ...stored.reasons] }, NOW);
    expect(still.verdict).toBe('caution');
    expect(still.reasons.map((r) => [r.code, r.value])).toEqual([
      ['wind_caution', undefined],
      ['forecast_stale', 195],
    ]);
  });
});
