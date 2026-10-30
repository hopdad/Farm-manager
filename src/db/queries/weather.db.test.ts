/**
 * Weather storage against the real database (as farm_app): forecast issues, observations,
 * retention (forecasts used by assessments survive, the newest assessment per field-hour
 * survives, processed NWS raw events go), the strip's reads, soil temperature readings, the
 * spray thresholds setting, and the pending index the forecast retention relies on.
 */
import { describe, expect, test } from 'vitest';
import { defaultSprayThresholdsSetting, type HourlyForecast } from '../../domain/weather';
import { setupTestDb } from '../../test/db';
import { insertField, squareMultiPolygon } from '../../test/fixtures';
import { buildWeatherStrip } from '../../ui/weather/strip-model';
import { exec } from '../exec';
import {
  assignFieldGrid,
  forecastCheckTimes,
  forecastHours,
  gridsInUse,
  insertForecastIssue,
  markForecastsChecked,
  newestIssues,
  pruneWeather,
  readSprayThresholds,
  upsertGrid,
  upsertObservation,
  writeSprayThresholds,
} from './weather';
import { writeAssessments } from './weather-spray';
import {
  insertSoilTemp,
  latestSoilTemp,
  loadStripData,
  soilTempFieldOptions,
} from './weather-strip';

const t = setupTestDb(import.meta.url);
const H = 3_600_000;
const GRID = { id: 'DTX/64,39', wfo: 'DTX', x: 64, y: 39 };

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

const floorHour = (ms: number) => Math.floor(ms / H) * H;

async function count(sql: string, values: unknown[] = []): Promise<number> {
  const r = await exec<{ n: number }>(
    t().pool,
    `select count(*)::int as n from (${sql}) x`,
    values,
  );
  return r.rows[0]?.n ?? 0;
}

describe('weather storage', () => {
  test('grids, forecasts and observations round-trip; issues are stored once', async () => {
    // One instant for the whole test: an hour starting between two `new Date()`s would move
    // the strip's first hour.
    const now = new Date();
    const f = await insertField(t().db, { geom: squareMultiPolygon(-84.06, 41.89, 500) });
    await upsertGrid(
      t().pool,
      GRID,
      [{ id: 'KADG', name: 'Adrian', lng: -84.0773, lat: 41.8676 }],
      'America/Detroit',
      new Date(),
    );
    await assignFieldGrid(
      t().pool,
      { fieldId: f.fieldId, lng: -84.057, lat: 41.892 },
      GRID.id,
      new Date(),
    );
    expect((await gridsInUse(t().pool)).map((g) => [g.id, g.fields, g.stations[0]?.id])).toEqual([
      [GRID.id, 1, 'KADG'],
    ]);

    const start = floorHour(now.getTime());
    const issue = {
      grid: GRID,
      issuedAt: new Date(start - 10 * 60_000).toISOString(),
      hours: [0, 1, 2].map((k) => hour(start + k * H, { windMph: 5 + k, gustMph: null })),
    };
    const cell = {
      type: 'Polygon' as const,
      coordinates: [
        [
          [-84.07, 41.88],
          [-84.04, 41.88],
          [-84.04, 41.9],
          [-84.07, 41.9],
          [-84.07, 41.88],
        ],
      ],
    };
    expect(await insertForecastIssue(t().pool, issue, cell)).toBe(3);
    expect(await insertForecastIssue(t().pool, issue, cell)).toBe(0);
    expect(await count('select 1 from farm.weather_grids where geom is not null')).toBe(1);
    expect((await newestIssues(t().pool, [GRID.id])).get(GRID.id)).toBe(issue.issuedAt);
    const back = await forecastHours(
      t().pool,
      GRID.id,
      issue.issuedAt,
      new Date(start),
      new Date(start + 2 * H),
    );
    expect(back).toEqual(issue.hours.slice(0, 2));

    // NWS checks are recorded for a stored issue only (one that failed to land vouches for
    // nothing), and only for cells that exist.
    const checkedAt = new Date(now.getTime() - 60_000);
    expect(
      await markForecastsChecked(
        t().pool,
        [
          { gridId: GRID.id, issuedAt: new Date(start).toISOString() },
          { gridId: 'DTX/1,1', issuedAt: issue.issuedAt },
        ],
        checkedAt,
      ),
    ).toBe(0);
    expect(await forecastCheckTimes(t().pool, [GRID.id])).toEqual(new Map());
    expect(
      await markForecastsChecked(
        t().pool,
        [{ gridId: GRID.id, issuedAt: issue.issuedAt }],
        checkedAt,
      ),
    ).toBe(1);
    // The time and the issue that check confirmed (the read paths credit only rows from it).
    expect(await forecastCheckTimes(t().pool, [GRID.id, 'DTX/1,1'])).toEqual(
      new Map([
        [
          GRID.id,
          {
            checkedAt: checkedAt.toISOString(),
            issuedAt: new Date(issue.issuedAt).toISOString(),
          },
        ],
      ]),
    );

    const obs = {
      stationId: 'KADG',
      stationName: 'Adrian',
      observedAt: new Date(start - 7 * 60_000).toISOString(),
      lng: -84.0773,
      lat: 41.8676,
      tempF: 48,
      dewpointF: 40,
      rhPct: 74,
      windMph: 7,
      gustMph: null,
      windDir: 250,
      precipLastHourIn: 0,
    };
    await upsertObservation(t().pool, obs);
    await upsertObservation(t().pool, { ...obs, windMph: 8 });
    expect(await count('select 1 from farm.weather_observations')).toBe(1);

    // The strip reads all of it.
    await insertSoilTemp(t().pool, {
      fieldId: f.fieldId,
      tempF: 52.5,
      depthIn: 2,
      observedAt: new Date(now.getTime() - 90 * 60_000).toISOString(),
      note: 'north end',
      enteredBy: null,
      deviceId: null,
    });
    const data = await loadStripData(t().pool, now);
    expect(data.grid).toEqual(GRID);
    expect(data.issuedAt).toBe(issue.issuedAt);
    expect(data.checkedAt).toBe(checkedAt.toISOString());
    expect(data.now).toMatchObject({ stationId: 'KADG', windMph: 8, stationName: 'Adrian' });
    expect(data.soilTemp).toMatchObject({ tempF: 52.5, fieldId: f.fieldId, source: 'manual' });
    const strip = buildWeatherStrip({
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
    });
    expect(strip.stale).toBe(false);
    expect(strip.fetchedAt).toBe(checkedAt.toISOString());
    expect(strip.hours[0]?.validAt).toBe(new Date(start).toISOString());
    expect(strip.soilTemp?.ageMinutes).toBe(90);
    expect((await latestSoilTemp(t().pool))?.tempF).toBe(52.5);
    expect((await soilTempFieldOptions(t().pool)).map((o) => o.id)).toContain(f.fieldId);
    const geom = await exec<{ inside: boolean }>(
      t().pool,
      `select extensions.ST_Intersects(s.geom, b.geom) as inside
         from farm.soil_temp_readings s join farm.current_boundaries b on b.field_id = s.field_id`,
    );
    expect(geom.rows[0]?.inside).toBe(true);
  });

  test('spray thresholds: missing or invalid means the defaults', async () => {
    await exec(t().admin, `delete from app.settings where key = 'spray.thresholds'`);
    expect(await readSprayThresholds(t().pool)).toEqual(defaultSprayThresholdsSetting());
    await exec(
      t().admin,
      `insert into app.settings (key, value) values ('spray.thresholds', '{"thresholds":{"windMaxMph":"x"}}')`,
    );
    expect(await readSprayThresholds(t().pool)).toEqual(defaultSprayThresholdsSetting());
    const custom = defaultSprayThresholdsSetting();
    custom.thresholds.windMaxMph = 12;
    custom.isDefault = false;
    custom.updatedAt = new Date().toISOString();
    custom.updatedBy = 'Derrick';
    await writeSprayThresholds(t().pool, custom);
    expect(await readSprayThresholds(t().pool)).toEqual(custom);
  });
});

describe('retention', () => {
  test('forecasts, assessments and raw events are pruned as the contract says, in batches', async () => {
    const now = new Date();
    const f = await insertField(t().db, {
      name: 'Prune',
      geom: squareMultiPolygon(-84.0, 41.9, 300),
    });
    const oldIssue = new Date(now.getTime() - 60 * H).toISOString();
    const newIssue = new Date(now.getTime() - H).toISOString();
    const h0 = floorHour(now.getTime() - 59 * H);
    await upsertGrid(t().pool, { id: 'DTX/70,40', wfo: 'DTX', x: 70, y: 40 }, [], null, now);
    const g = { id: 'DTX/70,40', wfo: 'DTX', x: 70, y: 40 };
    await insertForecastIssue(
      t().pool,
      { grid: g, issuedAt: oldIssue, hours: [0, 1, 2, 3].map((k) => hour(h0 + k * H)) },
      null,
    );
    await insertForecastIssue(
      t().pool,
      {
        grid: g,
        issuedAt: newIssue,
        hours: [0, 1].map((k) => hour(floorHour(now.getTime()) + k * H)),
      },
      null,
    );
    // An assessment used the old issue's hour h0+1: that forecast row stays.
    const base = { reasons: [], inputs: {}, gridId: g.id, verdict: 'go' as const };
    await writeAssessments(t().pool, [
      {
        ...base,
        fieldId: f.fieldId,
        forHour: new Date(h0 + H).toISOString(),
        rulesVersion: 'v0-a',
        forecastIssuedAt: oldIssue,
      },
    ]);
    // Two calls for an hour 40 days ago: the older one goes, the newest stays.
    const oldHour = new Date(floorHour(now.getTime() - 40 * 24 * H)).toISOString();
    await writeAssessments(t().pool, [
      {
        ...base,
        fieldId: f.fieldId,
        forHour: oldHour,
        rulesVersion: 'v0-a',
        forecastIssuedAt: null,
      },
    ]);
    await exec(
      t().admin,
      `update farm.spray_assessments set assessed_at = assessed_at - interval '1 minute' where for_hour = $1`,
      [oldHour],
    );
    await writeAssessments(t().pool, [
      {
        ...base,
        fieldId: f.fieldId,
        forHour: oldHour,
        rulesVersion: 'v0-b',
        forecastIssuedAt: null,
        verdict: 'no_go',
      },
    ]);
    // Raw events: processed nws 3 days old (goes), pending nws (stays), old samsara (stays).
    await exec(
      t().admin,
      `insert into ingest.raw_events (source, stream, external_id, payload, sha256, status, processed_at)
       values ('nws', 'forecast', 'a', '{}', repeat('a', 64), 'processed', now() - interval '3 days'),
              ('nws', 'forecast', 'b', '{}', repeat('b', 64), 'processed', now() - interval '3 days'),
              ('nws', 'forecast', 'c', '{}', repeat('c', 64), 'pending', null),
              ('samsara', 'positions', 'd', '{}', repeat('d', 64), 'processed', now() - interval '3 days')`,
    );

    const r = await pruneWeather(t().pool, now, new Date(now.getTime() + 60_000), { batch: 1 });
    expect(r).toEqual({ forecasts: 3, assessments: 1, rawEvents: 2, complete: true });
    const kept = await exec<{ valid_at: Date }>(
      t().pool,
      'select valid_at from farm.weather_forecasts where issued_at = $1',
      [oldIssue],
    );
    expect(kept.rows.map((x) => x.valid_at.toISOString())).toEqual([
      new Date(h0 + H).toISOString(),
    ]);
    expect(
      await count('select 1 from farm.weather_forecasts where issued_at = $1', [newIssue]),
    ).toBe(2);
    const old = await exec<{ verdict: string }>(
      t().pool,
      'select verdict from farm.spray_assessments where for_hour = $1',
      [oldHour],
    );
    expect(old.rows).toEqual([{ verdict: 'no_go' }]);
    expect(await count(`select 1 from ingest.raw_events where source = 'nws'`)).toBe(1);
    expect(await count(`select 1 from ingest.raw_events where source = 'samsara'`)).toBe(1);

    // A deadline in the past stops at once.
    const stopped = await pruneWeather(t().pool, now, new Date(0));
    expect(stopped.complete).toBe(false);
  });

  test('the forecast retention index exists (db/pending/weather.sql)', async () => {
    const r = await exec(
      t().pool,
      `select 1 from pg_indexes where schemaname = 'farm'
          and indexname = 'spray_assessments_grid_id_forecast_issued_at_for_hour_idx'`,
    );
    expect(r.rowCount).toBe(1);
  });
});
