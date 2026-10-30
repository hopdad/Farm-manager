/**
 * Weather storage (plan 1b; docs/contracts-m1.md §3.1, §13): the cached NWS grid cells and each
 * field's cell, forecast issues and when NWS last confirmed them, station observations, the
 * spray thresholds setting and the retention the weather.nws job runs. Raw SQL through `exec` (pg pool/client or Drizzle tx).
 *
 * Tables: farm.weather_grids, farm.field_weather_grids, farm.weather_forecasts,
 * farm.weather_observations, app.settings 'spray.thresholds', ingest.raw_events (source 'nws').
 */
import type { Polygon } from 'geojson';
import {
  FORECAST_RETENTION_HOURS,
  type ForecastIssue,
  type GridRef,
  type HourlyForecast,
  type Observation,
  parseSprayThresholdsSetting,
  SPRAY_DETAIL_RETENTION_DAYS,
  SPRAY_THRESHOLDS_SETTING_KEY,
  type SprayThresholdsSetting,
  type WeatherStation,
} from '../../domain/weather';
import { type Executor, exec, toDate } from '../exec';

/** Re-verify a field's grid cell after this many days (NWS: "periodically re-verify"). */
export const GRID_LOOKUP_MAX_AGE_DAYS = 30;
/** Processed NWS raw events are kept this long (the normalized rows are the record). */
export const NWS_RAW_RETENTION_HOURS = 48;
/** Rows per pruning statement (the job loops while time remains). */
export const PRUNE_BATCH = 5_000;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Where the cached grid cells came from (app.settings 'weather.grid_source')
// ---------------------------------------------------------------------------------------------

/** app.settings key: the NWS source the cached cells were looked up at ('sim', 'replay', 'nws'). */
export const GRID_SOURCE_SETTING_KEY = 'weather.grid_source';

/** The source a mode's cells come from: sandbox and live are both api.weather.gov. */
export function gridSourceOf(mode: 'sim' | 'replay' | 'sandbox' | 'live'): string {
  return mode === 'live' || mode === 'sandbox' ? 'nws' : mode;
}

/**
 * Cells are only valid for the source that named them: the stand-in's lattice is not NWS's
 * Lambert grid, so switching CONNECTOR_WEATHER from sim to live must not query api.weather.gov
 * for sim cell ids. When the source changed (or is unknown while cells exist), drop every cached
 * cell (field assignments and forecasts cascade; assessments keep their grid id as history), then
 * record the new source. Returns the number of cells dropped. Idempotent: a crash between the two
 * statements repeats the delete on the next run.
 */
export async function switchGridSource(ex: Executor, source: string): Promise<number> {
  const r = await exec<{ source: string | null }>(
    ex,
    `select value #>> '{}' as source from app.settings where key = $1`,
    [GRID_SOURCE_SETTING_KEY],
  );
  const previous = r.rows[0]?.source ?? null;
  if (previous === source) return 0;
  const dropped = await exec(ex, 'delete from farm.weather_grids');
  await exec(
    ex,
    `insert into app.settings (key, value, updated_at) values ($1, to_jsonb($2::text), now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [GRID_SOURCE_SETTING_KEY, source],
  );
  return dropped.rowCount ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Spray thresholds (app.settings 'spray.thresholds'; readers always parse: invalid = defaults)
// ---------------------------------------------------------------------------------------------

export async function readSprayThresholds(ex: Executor): Promise<SprayThresholdsSetting> {
  const r = await exec<{ value: unknown }>(ex, 'select value from app.settings where key = $1', [
    SPRAY_THRESHOLDS_SETTING_KEY,
  ]);
  return parseSprayThresholdsSetting(r.rows[0]?.value);
}

export async function writeSprayThresholds(
  ex: Executor,
  setting: SprayThresholdsSetting,
): Promise<void> {
  await exec(
    ex,
    `insert into app.settings (key, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [SPRAY_THRESHOLDS_SETTING_KEY, JSON.stringify(setting)],
  );
}

// ---------------------------------------------------------------------------------------------
// Grid cells
// ---------------------------------------------------------------------------------------------

export interface FieldPoint {
  fieldId: string;
  /** A point inside the current boundary (ST_PointOnSurface). */
  lng: number;
  lat: number;
}

/**
 * Active fields with a current boundary whose cell must be looked up: never looked up, looked up
 * before the boundary version started or outside it (the boundary moved), or longer ago than
 * GRID_LOOKUP_MAX_AGE_DAYS.
 */
export async function fieldsNeedingGrid(
  ex: Executor,
  now: Date,
  limit = 1_000,
): Promise<FieldPoint[]> {
  const r = await exec<{ field_id: string; lng: number; lat: number }>(
    ex,
    `select f.id::text as field_id,
            extensions.ST_X(p.pt) as lng, extensions.ST_Y(p.pt) as lat
       from farm.fields f
       join farm.current_boundaries b on b.field_id = f.id
       cross join lateral (select extensions.ST_PointOnSurface(b.geom) as pt) p
       left join farm.field_weather_grids w on w.field_id = f.id
      where f.active
        and (w.field_id is null
             or w.looked_up_at < $1::timestamptz
             or w.looked_up_at < lower(b.valid)
             or not extensions.ST_Intersects(b.geom, w.point))
      order by f.id
      limit $2`,
    [new Date(now.getTime() - GRID_LOOKUP_MAX_AGE_DAYS * DAY_MS).toISOString(), limit],
  );
  return r.rows.map((x) => ({ fieldId: x.field_id, lng: Number(x.lng), lat: Number(x.lat) }));
}

/**
 * A cached cell whose outline contains the point and that was looked up recently enough: the
 * field can use it without asking NWS (most fields share a few cells).
 */
export async function cachedGridAt(
  ex: Executor,
  lng: number,
  lat: number,
  now: Date,
): Promise<string | null> {
  const r = await exec<{ id: string }>(
    ex,
    `select g.id from farm.weather_grids g
      where g.geom is not null
        and g.looked_up_at >= $3::timestamptz
        and extensions.ST_Intersects(
              g.geom, extensions.ST_SetSRID(extensions.ST_MakePoint($1::float8, $2::float8), 4326))
      order by g.looked_up_at desc, g.id
      limit 1`,
    [lng, lat, new Date(now.getTime() - GRID_LOOKUP_MAX_AGE_DAYS * DAY_MS).toISOString()],
  );
  return r.rows[0]?.id ?? null;
}

/** Is the cell cached with its stations, looked up recently enough? */
export async function gridIsFresh(ex: Executor, gridId: string, now: Date): Promise<boolean> {
  const r = await exec(
    ex,
    `select 1 from farm.weather_grids
      where id = $1 and looked_up_at >= $2::timestamptz and jsonb_array_length(stations) > 0`,
    [gridId, new Date(now.getTime() - GRID_LOOKUP_MAX_AGE_DAYS * DAY_MS).toISOString()],
  );
  return r.rowCount > 0;
}

export async function upsertGrid(
  ex: Executor,
  grid: GridRef,
  stations: WeatherStation[],
  timeZone: string | null,
  lookedUpAt: Date,
): Promise<void> {
  await exec(
    ex,
    `insert into farm.weather_grids (id, wfo, grid_x, grid_y, stations, time_zone, looked_up_at, updated_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz, now())
     on conflict (id) do update
       set stations = excluded.stations, time_zone = coalesce(excluded.time_zone, farm.weather_grids.time_zone),
           looked_up_at = excluded.looked_up_at, updated_at = now()`,
    [
      grid.id,
      grid.wfo,
      grid.x,
      grid.y,
      JSON.stringify(stations),
      timeZone,
      lookedUpAt.toISOString(),
    ],
  );
}

/** The field's cell is `gridId` (looked up at the point). */
export async function assignFieldGrid(
  ex: Executor,
  p: FieldPoint,
  gridId: string,
  lookedUpAt: Date,
): Promise<void> {
  await exec(
    ex,
    `insert into farm.field_weather_grids (field_id, grid_id, point, looked_up_at)
     values ($1::uuid, $2, extensions.ST_SetSRID(extensions.ST_MakePoint($3::float8, $4::float8), 4326), $5::timestamptz)
     on conflict (field_id) do update
       set grid_id = excluded.grid_id, point = excluded.point, looked_up_at = excluded.looked_up_at`,
    [p.fieldId, gridId, p.lng, p.lat, lookedUpAt.toISOString()],
  );
}

export interface GridInUse extends GridRef {
  stations: WeatherStation[];
  fields: number;
}

/** The cells of active fields with a current boundary, most fields first. */
export async function gridsInUse(ex: Executor): Promise<GridInUse[]> {
  const r = await exec<{
    id: string;
    wfo: string;
    grid_x: number;
    grid_y: number;
    stations: WeatherStation[];
    fields: string | number;
  }>(
    ex,
    `select g.id, g.wfo, g.grid_x, g.grid_y, g.stations, count(*) as fields
       from farm.field_weather_grids w
       join farm.fields f on f.id = w.field_id and f.active
       join farm.current_boundaries b on b.field_id = f.id
       join farm.weather_grids g on g.id = w.grid_id
      group by g.id
      order by count(*) desc, g.id`,
  );
  return r.rows.map((x) => ({
    id: x.id,
    wfo: x.wfo,
    x: x.grid_x,
    y: x.grid_y,
    stations: Array.isArray(x.stations) ? x.stations : [],
    fields: Number(x.fields),
  }));
}

// ---------------------------------------------------------------------------------------------
// Forecasts and observations
// ---------------------------------------------------------------------------------------------

/**
 * Store one forecast issue (one row per hour; an issue already stored is a no-op) and the cell
 * outline the answer carried. Returns rows inserted.
 */
export async function insertForecastIssue(
  ex: Executor,
  issue: ForecastIssue,
  cell: Polygon | null,
): Promise<number> {
  if (cell) {
    await exec(
      ex,
      `update farm.weather_grids
          set geom = extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($2::text), 4326),
              updated_at = now()
        where id = $1
          and (geom is null
               or not extensions.ST_Equals(geom, extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON($2::text), 4326)))`,
      [issue.grid.id, JSON.stringify(cell)],
    );
  }
  if (!issue.hours.length) return 0;
  const r = await exec(
    ex,
    `insert into farm.weather_forecasts
       (grid_id, issued_at, valid_at, temp_f, dewpoint_f, rh_pct, wind_mph, gust_mph, wind_dir,
        pop_pct, qpf_in, sky_pct, mixing_height_ft, transport_wind_mph, source)
     select $1, $2::timestamptz, (h->>'validAt')::timestamptz,
            (h->>'tempF')::float8, (h->>'dewpointF')::float8, (h->>'rhPct')::float8,
            (h->>'windMph')::float8, (h->>'gustMph')::float8, (h->>'windDir')::float8,
            (h->>'popPct')::float8, (h->>'qpfIn')::float8, (h->>'skyPct')::float8,
            (h->>'mixingHeightFt')::float8, (h->>'transportWindMph')::float8, 'nws'
       from jsonb_array_elements($3::jsonb) as h
     on conflict (grid_id, issued_at, valid_at) do nothing`,
    [issue.grid.id, issue.issuedAt, JSON.stringify(issue.hours)],
  );
  return r.rowCount;
}

/** Store (or refresh: NWS revises QC'd values) one observation. */
export async function upsertObservation(ex: Executor, o: Observation): Promise<void> {
  await exec(
    ex,
    `insert into farm.weather_observations
       (station_id, observed_at, geom, temp_f, dewpoint_f, rh_pct, wind_mph, gust_mph, wind_dir,
        precip_last_hour_in, source)
     values ($1, $2::timestamptz,
             case when $3::float8 is null or $4::float8 is null then null
                  else extensions.ST_SetSRID(extensions.ST_MakePoint($3::float8, $4::float8), 4326) end,
             $5, $6, $7, $8, $9, $10, $11, 'nws')
     on conflict (station_id, observed_at) do update
       set geom = excluded.geom, temp_f = excluded.temp_f, dewpoint_f = excluded.dewpoint_f,
           rh_pct = excluded.rh_pct, wind_mph = excluded.wind_mph, gust_mph = excluded.gust_mph,
           wind_dir = excluded.wind_dir, precip_last_hour_in = excluded.precip_last_hour_in,
           fetched_at = now()`,
    [
      o.stationId,
      o.observedAt,
      o.lng,
      o.lat,
      o.tempF,
      o.dewpointF,
      o.rhPct,
      o.windMph,
      o.gustMph,
      o.windDir,
      o.precipLastHourIn,
    ],
  );
}

/** Newest issue per cell: grid id -> issued_at (ISO). */
export async function newestIssues(ex: Executor, gridIds: string[]): Promise<Map<string, string>> {
  if (!gridIds.length) return new Map();
  const r = await exec<{ grid_id: string; issued_at: unknown }>(
    ex,
    `select grid_id, max(issued_at) as issued_at from farm.weather_forecasts
      where grid_id = any($1::text[]) group by grid_id`,
    [gridIds],
  );
  return new Map(
    r.rows.map((x) => [x.grid_id, (toDate(x.issued_at) as Date).toISOString()] as const),
  );
}

/**
 * NWS answered for these cells at `at` (a new issue or the same one again): the issue it served
 * is current as of then (farm.weather_grids.forecast_checked_at, with that issue in
 * forecast_checked_issue; the staleness rule in src/domain/spray.ts counts from it, for rows
 * built from that issue only). Only cells whose answered issue is stored are marked: an issue
 * that failed to process doesn't vouch for the older one. Returns cells marked.
 */
export async function markForecastsChecked(
  ex: Executor,
  checked: readonly { gridId: string; issuedAt: string }[],
  at: Date,
): Promise<number> {
  if (!checked.length) return 0;
  const r = await exec(
    ex,
    `update farm.weather_grids g
        set forecast_checked_at = $3::timestamptz, forecast_checked_issue = c.issued_at
       from unnest($1::text[], $2::timestamptz[]) as c(grid_id, issued_at)
      where g.id = c.grid_id
        and exists (select 1 from farm.weather_forecasts f
                     where f.grid_id = c.grid_id and f.issued_at = c.issued_at)`,
    [checked.map((c) => c.gridId), checked.map((c) => c.issuedAt), at.toISOString()],
  );
  return r.rowCount;
}

/**
 * When each cell's forecast was last confirmed with NWS, and the issue that check confirmed:
 * grid id -> ISO times (never: left out).
 */
export async function forecastCheckTimes(
  ex: Executor,
  gridIds: string[],
): Promise<Map<string, { checkedAt: string; issuedAt: string }>> {
  if (!gridIds.length) return new Map();
  const r = await exec<{
    id: string;
    forecast_checked_at: unknown;
    forecast_checked_issue: unknown;
  }>(
    ex,
    `select id, forecast_checked_at, forecast_checked_issue from farm.weather_grids
      where id = any($1::text[])
        and forecast_checked_at is not null and forecast_checked_issue is not null`,
    [gridIds],
  );
  return new Map(
    r.rows.map(
      (x) =>
        [
          x.id,
          {
            checkedAt: (toDate(x.forecast_checked_at) as Date).toISOString(),
            issuedAt: (toDate(x.forecast_checked_issue) as Date).toISOString(),
          },
        ] as const,
    ),
  );
}

/** One issue's hours in [from, to). */
export async function forecastHours(
  ex: Executor,
  gridId: string,
  issuedAt: string,
  from: Date,
  to: Date,
): Promise<HourlyForecast[]> {
  const r = await exec<Record<string, unknown>>(
    ex,
    `select valid_at, temp_f, dewpoint_f, rh_pct, wind_mph, gust_mph, wind_dir, pop_pct, qpf_in,
            sky_pct, mixing_height_ft, transport_wind_mph
       from farm.weather_forecasts
      where grid_id = $1 and issued_at = $2::timestamptz
        and valid_at >= $3::timestamptz and valid_at < $4::timestamptz
      order by valid_at`,
    [gridId, issuedAt, from.toISOString(), to.toISOString()],
  );
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return r.rows.map((x) => ({
    validAt: (toDate(x.valid_at) as Date).toISOString(),
    tempF: n(x.temp_f),
    dewpointF: n(x.dewpoint_f),
    rhPct: n(x.rh_pct),
    windMph: n(x.wind_mph),
    gustMph: n(x.gust_mph),
    windDir: n(x.wind_dir),
    popPct: n(x.pop_pct),
    qpfIn: n(x.qpf_in),
    skyPct: n(x.sky_pct),
    mixingHeightFt: n(x.mixing_height_ft),
    transportWindMph: n(x.transport_wind_mph),
  }));
}

// ---------------------------------------------------------------------------------------------
// Retention (docs/contracts-m1.md §13), in batches so a run stays in its budget
// ---------------------------------------------------------------------------------------------

export interface PruneResult {
  forecasts: number;
  assessments: number;
  rawEvents: number;
  /** False when the deadline stopped it before everything due was deleted. */
  complete: boolean;
}

/**
 * Delete what retention allows, PRUNE_BATCH rows per statement, until done or `deadline`:
 *  - forecast rows of issues older than FORECAST_RETENTION_HOURS, except the (grid, issue, hour)
 *    rows a stored assessment used;
 *  - assessments whose hour is older than SPRAY_DETAIL_RETENTION_DAYS, except the newest per
 *    (field, hour) (by assessed_at, then id): what the farm was told last;
 *  - processed NWS raw events older than NWS_RAW_RETENTION_HOURS.
 */
export async function pruneWeather(
  ex: Executor,
  now: Date,
  deadline: Date,
  opts: { batch?: number; clock?: () => number } = {},
): Promise<PruneResult> {
  const batch = opts.batch ?? PRUNE_BATCH;
  const clock = opts.clock ?? Date.now;
  const out: PruneResult = { forecasts: 0, assessments: 0, rawEvents: 0, complete: true };
  const steps: [keyof Omit<PruneResult, 'complete'>, string, string][] = [
    [
      'forecasts',
      `delete from farm.weather_forecasts where ctid = any(array(
         select f.ctid from farm.weather_forecasts f
          where f.issued_at < $1::timestamptz
            and not exists (select 1 from farm.spray_assessments s
                             where s.grid_id = f.grid_id and s.forecast_issued_at = f.issued_at
                               and s.for_hour = f.valid_at)
          limit $2))`,
      new Date(now.getTime() - FORECAST_RETENTION_HOURS * 3_600_000).toISOString(),
    ],
    [
      'assessments',
      `delete from farm.spray_assessments where id = any(array(
         select s.id from farm.spray_assessments s
          where s.for_hour < $1::timestamptz
            and exists (select 1 from farm.spray_assessments n
                         where n.field_id = s.field_id and n.for_hour = s.for_hour
                           and (n.assessed_at, n.id) > (s.assessed_at, s.id))
          limit $2))`,
      new Date(now.getTime() - SPRAY_DETAIL_RETENTION_DAYS * DAY_MS).toISOString(),
    ],
    [
      'rawEvents',
      `delete from ingest.raw_events where id = any(array(
         select id from ingest.raw_events
          where source = 'nws' and status = 'processed' and processed_at < $1::timestamptz
          limit $2))`,
      new Date(now.getTime() - NWS_RAW_RETENTION_HOURS * 3_600_000).toISOString(),
    ],
  ];
  for (const [key, sql, cutoff] of steps) {
    for (;;) {
      if (clock() >= deadline.getTime()) {
        out.complete = false;
        return out;
      }
      const r = await exec(ex, sql, [cutoff, batch]);
      out[key] += r.rowCount;
      if (r.rowCount < batch) break;
    }
  }
  return out;
}
