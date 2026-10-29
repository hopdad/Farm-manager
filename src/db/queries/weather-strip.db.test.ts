/**
 * The weather strip and the field panel show a stored spray verdict the way the map and
 * GET /api/weather/spray do: once the forecast it used is older than WEATHER_STALE_MINUTES
 * (NWS unreachable), every view adds forecast_stale (caution), even though the stored row
 * (keyed on the forecast issue) still says go.
 */
import { describe, expect, test } from 'vitest';
import { withStaleness } from '../../domain/spray';
import { DEFAULT_SPRAY_THRESHOLDS, type HourlyForecast } from '../../domain/weather';
import { setupTestDb } from '../../test/db';
import { insertField, squareMultiPolygon } from '../../test/fixtures';
import { buildWeatherStrip } from '../../ui/weather/strip-model';
import { fieldDetail } from './fields';
import { assignFieldGrid, insertForecastIssue, upsertGrid } from './weather';
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

describe('spray verdicts as shown now', () => {
  test('a stale forecast is caution in the strip, the field panel and the map alike', async () => {
    const { pool, db } = t();
    const f = await insertField(db, { geom: squareMultiPolygon(-84.06, 41.89, 500) });
    await upsertGrid(pool, GRID, [], 'America/Detroit', T0);
    await assignFieldGrid(pool, { fieldId: f.fieldId, lng: -84.057, lat: 41.892 }, GRID.id, T0);
    const start = Math.floor(T0.getTime() / H) * H;
    await insertForecastIssue(
      pool,
      {
        grid: GRID,
        issuedAt: new Date(T0.getTime() - 5 * 60_000).toISOString(),
        hours: Array.from({ length: 24 }, (_, k) => calm(start + k * H)),
      },
      null,
    );
    await runSprayPass(pool, T0, DEFAULT_SPRAY_THRESHOLDS);

    // Fresh: go everywhere.
    const fresh = await loadStripData(pool, T0);
    expect(fresh.verdicts).toEqual(['go']);

    // Three hours later NWS is still unreachable: no new issue, the pass reuses the old rows.
    const later = new Date(T0.getTime() + 3 * H);
    await runSprayPass(pool, later, DEFAULT_SPRAY_THRESHOLDS);
    const forHour = new Date(start + 3 * H).toISOString();
    const stored = (await verdictsForHour(pool, forHour)).get(f.fieldId);
    expect(stored?.verdict).toBe('go');
    // What GET /api/weather/spray (the map) shows:
    expect(stored && withStaleness(stored, later).verdict).toBe('caution');

    const data = await loadStripData(pool, later);
    expect(data.verdicts).toEqual(['caution']);
    expect(data.referenceVerdicts.get(forHour)).toBe('caution');
    const strip = buildWeatherStrip({
      now: later,
      mode: 'sim',
      grid: data.grid,
      issuedAt: data.issuedAt,
      fetchedAt: data.fetchedAt,
      hours: data.hours,
      observation: data.now,
      soilTemp: data.soilTemp,
      verdicts: data.verdicts,
      referenceVerdicts: data.referenceVerdicts,
    });
    expect(strip.spray).toMatchObject({ go: 0, caution: 1, noGo: 0 });

    const detail = await fieldDetail(pool, f.fieldId, later);
    expect(detail?.spray?.verdict).toBe('caution');
    expect(detail?.spray?.reasons.map((r) => r.code)).toContain('forecast_stale');
  });
});
