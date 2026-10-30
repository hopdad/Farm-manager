/**
 * The weather strip and the field panel show a stored spray verdict the way the map and
 * GET /api/weather/spray do: once the forecast it used has not been confirmed with NWS for
 * WEATHER_STALE_MINUTES (NWS unreachable), every view adds forecast_stale (caution), even though
 * the stored row (keyed on the forecast issue) still says go; and once NWS serves the same issue
 * again, every view shows it current, however old the issue itself is.
 */
import { describe, expect, test } from 'vitest';
import { withStaleness } from '../../domain/spray';
import { DEFAULT_SPRAY_THRESHOLDS, type HourlyForecast } from '../../domain/weather';
import { setupTestDb } from '../../test/db';
import { insertField, squareMultiPolygon } from '../../test/fixtures';
import { buildWeatherStrip } from '../../ui/weather/strip-model';
import { fieldDetail } from './fields';
import { assignFieldGrid, insertForecastIssue, markForecastsChecked, upsertGrid } from './weather';
import { runSprayPass, verdictsForHour } from './weather-spray';
import { loadStripData } from './weather-strip';

const t = setupTestDb(import.meta.url);
const H = 3_600_000;
const GRID = { id: 'DTX/64,39', wfo: 'DTX', x: 64, y: 39 };
/** Mid-afternoon in Michigan: no sunrise or sunset inversion window. */
const T0 = new Date('2026-11-16T19:10:00Z');

function calm(ms: number): HourlyForecast {
  return {
    validAt: new Date(ms).toISOString(),
    tempF: 50,
    dewpointF: 40,
    rhPct: 68,
    windMph: 6,
    gustMph: 9,
    windDir: 220,
    popPct: 0,
    qpfIn: 0,
    skyPct: 60,
    mixingHeightFt: 3000,
    transportWindMph: 12,
  };
}

async function strip(now: Date) {
  const data = await loadStripData(t().pool, now);
  return {
    data,
    strip: buildWeatherStrip({
      now,
      mode: 'sim',
      grid: data.grid,
      issuedAt: data.issuedAt,
      fetchedAt: data.fetchedAt,
      checkedAt: data.checkedAt,
      hours: data.hours,
      observation: data.now,
      soilTemp: data.soilTemp,
      verdicts: data.verdicts,
      referenceVerdicts: data.referenceVerdicts,
    }),
  };
}

describe('spray verdicts as shown now', () => {
  test('a stale forecast is caution in the strip, the field panel and the map alike', async () => {
    const { pool, db } = t();
    const f = await insertField(db, { geom: squareMultiPolygon(-84.06, 41.89, 500) });
    await upsertGrid(pool, GRID, [], 'America/Detroit', T0);
    await assignFieldGrid(pool, { fieldId: f.fieldId, lng: -84.057, lat: 41.892 }, GRID.id, T0);
    const start = Math.floor(T0.getTime() / H) * H;
    const issue = {
      grid: GRID,
      issuedAt: new Date(T0.getTime() - 5 * 60_000).toISOString(),
      hours: Array.from({ length: 24 }, (_, k) => calm(start + k * H)),
    };
    await insertForecastIssue(pool, issue, null);
    // The job stored it and NWS answered: current as of T0.
    await markForecastsChecked(pool, [{ gridId: GRID.id, issuedAt: issue.issuedAt }], T0);
    await runSprayPass(pool, T0, DEFAULT_SPRAY_THRESHOLDS);

    // Fresh: go everywhere.
    const fresh = await loadStripData(pool, T0);
    expect(fresh.verdicts).toEqual(['go']);

    // Three hours later NWS is still unreachable: no new issue, no check, the pass reuses the
    // old rows.
    const later = new Date(T0.getTime() + 3 * H);
    await runSprayPass(pool, later, DEFAULT_SPRAY_THRESHOLDS);
    const forHour = new Date(start + 3 * H).toISOString();
    const stored = (await verdictsForHour(pool, forHour)).get(f.fieldId);
    expect(stored?.verdict).toBe('go');
    expect(stored?.forecastCheckedAt).toBe(T0.toISOString());
    // What GET /api/weather/spray (the map) shows:
    expect(stored && withStaleness(stored, later).verdict).toBe('caution');

    const outage = await strip(later);
    expect(outage.data.verdicts).toEqual(['caution']);
    expect(outage.data.referenceVerdicts.get(forHour)).toBe('caution');
    expect(outage.strip).toMatchObject({ stale: true, fetchedAt: T0.toISOString() });
    expect(outage.strip.spray).toMatchObject({ go: 0, caution: 1, noGo: 0 });

    const detail = await fieldDetail(pool, f.fieldId, later);
    expect(detail?.spray?.verdict).toBe('caution');
    expect(detail?.spray?.forecastCheckedAt).toBe(T0.toISOString());
    expect(detail?.spray?.reasons.find((r) => r.code === 'forecast_stale')?.message).toBe(
      'Forecast not checked for 3 h (NWS unreachable)',
    );
    // The hours that entered the window during the outage were stored stale.
    const entered = new Date(start + 15 * H).toISOString();
    expect(
      (await verdictsForHour(pool, entered)).get(f.fieldId)?.reasons.map((r) => r.code),
    ).toEqual(['forecast_stale']);

    // NWS is back and serves the same issue (3.5 h old now): current again in every view, the
    // reason stored during the outage included.
    const back = new Date(later.getTime() + 30 * 60_000);
    await markForecastsChecked(pool, [{ gridId: GRID.id, issuedAt: issue.issuedAt }], back);
    await runSprayPass(pool, back, DEFAULT_SPRAY_THRESHOLDS);
    const restored = await strip(back);
    expect(restored.data.verdicts).toEqual(['go']);
    expect(restored.strip).toMatchObject({
      stale: false,
      issuedAt: issue.issuedAt,
      fetchedAt: back.toISOString(),
      spray: { go: 1, caution: 0, noGo: 0 },
    });
    expect(restored.data.referenceVerdicts.get(entered)).toBe('go');
    const again = await fieldDetail(pool, f.fieldId, back);
    expect(again?.spray).toMatchObject({ verdict: 'go', reasons: [] });
    const shown = (await verdictsForHour(pool, entered)).get(f.fieldId);
    expect(shown && withStaleness(shown, back)).toMatchObject({ verdict: 'go', reasons: [] });
  });
});
