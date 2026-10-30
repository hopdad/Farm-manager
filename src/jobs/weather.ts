/**
 * weather.nws (plan 1b; docs/contracts-m1.md §13): every 30 min (30 s in the local demo cadence).
 * One run:
 *
 *  0. Cells are cached per source (app.settings 'weather.grid_source'): switching
 *     CONNECTOR_WEATHER between sim, replay and live drops them first (`switchGridSource`).
 *  1. Grid lookups (cached): fields without a cell, whose boundary moved, or looked up more than
 *     GRID_LOOKUP_MAX_AGE_DAYS ago get one. A cached cell whose outline contains the field's
 *     point is reused; otherwise `/points/{lat},{lon}` names it and, for a new cell,
 *     `/gridpoints/{wfo}/{x},{y}/stations` lists its stations (farm.weather_grids).
 *  2. Forecasts, as the sync step ('nws', 'forecast'): `/gridpoints/{wfo}/{x},{y}` of every cell
 *     in use; a new `updateTime` lands as one raw event (trimmed to the layers and days the app
 *     uses), which maps to one row per hour in farm.weather_forecasts (`issued_at`). When the
 *     step succeeds, every cell NWS answered for (a new issue or the same one again) gets
 *     farm.weather_grids.forecast_checked_at = now: staleness counts from there, because live
 *     NWS often keeps one `updateTime` for hours.
 *  3. Observations, as the sync step ('nws', 'observations'): the nearest station of each cell,
 *     since the last one stored (at most 3 h back) -> farm.weather_observations.
 *  4. Spray go/no-go: every active field, the current hour plus the next 12, from the newest
 *     issue of its cell, with the thresholds in app.settings 'spray.thresholds'
 *     (farm.spray_assessments; src/db/queries/weather-spray.ts).
 *  5. Retention, at most once per UTC hour (src/db/queries/weather.ts `pruneWeather`).
 *  6. Realtime: weather/updated when forecasts or observations landed; spray/assessed when rows
 *     were written; fields/updated {parts: ['spray']} for each field whose current verdict
 *     changed (more than FIELD_UPDATE_LIMIT: one fields/invalidate instead).
 *
 * A failed forecast or observation step still lets the spray pass run (a forecast not checked
 * for WEATHER_STALE_MINUTES is assessed stale), then the job throws so ingest.job_runs records
 * the failure. CONNECTOR_WEATHER=off: the job does nothing.
 */

import type { Polygon } from 'geojson';
import { type Config, getConfig } from '../config';
import { NwsClient, type NwsHttpOptions } from '../connectors/nws/client';
import { gridOfPoint, mapGridpoint, mapObservation, trimGridpoint } from '../connectors/nws/mapper';
import type { NwsGridpoint, NwsObservation } from '../connectors/nws/schemas';
import { runSyncStep } from '../connectors/sync-step';
import {
  type RawItem,
  type SyncContext,
  SyncStepError,
  type SyncStepResult,
  type SyncStepSpec,
} from '../connectors/types';
import { exec, toDate } from '../db/exec';
import {
  assignFieldGrid,
  cachedGridAt,
  fieldsNeedingGrid,
  type GridInUse,
  gridIsFresh,
  gridSourceOf,
  gridsInUse,
  insertForecastIssue,
  markForecastsChecked,
  pruneWeather,
  readSprayThresholds,
  switchGridSource,
  upsertGrid,
  upsertObservation,
} from '../db/queries/weather';
import { runSprayPass, type SprayPassResult } from '../db/queries/weather-spray';
import type { ForecastIssue, Observation } from '../domain/weather';
import { publish } from '../platform/realtime/publish';
import type { JobContext, JobResult } from './types';

export type WeatherConfig = Pick<Config, 'CONNECTOR_WEATHER' | 'VENDOR_SIM_URL' | 'NWS_USER_AGENT'>;

export interface WeatherJobOptions {
  /** Default: getConfig() at run time. */
  config?: () => WeatherConfig;
  /** HTTP knobs for the NWS client (tests: fetch, sleep, timeouts). */
  http?: NwsHttpOptions;
}

export const NWS_SOURCE = 'nws';
export const FORECAST_STREAM = 'forecast';
export const OBSERVATIONS_STREAM = 'observations';
/** Parallel NWS requests per step. */
const CONCURRENCY = 4;
/** A landed issue keeps hours from 2 h before its update to 5 days after it. */
const ISSUE_HOURS_BEFORE = 2;
const ISSUE_DAYS_AFTER = 5;
/** Observations are fetched at most this far back. */
const OBSERVATION_LOOKBACK_MS = 3 * 3_600_000;
/** More changed fields than this: one fields/invalidate instead of one fields/updated each. */
export const FIELD_UPDATE_LIMIT = 20;
const HOUR_MS = 3_600_000;

interface ForecastItem {
  issue: ForecastIssue;
  cell: Polygon | null;
}

/** Run `fn` over `items`, `limit` at a time. */
async function eachLimit<T>(items: readonly T[], limit: number, fn: (t: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const timeLeft = (ctx: JobContext) =>
  !ctx.signal.aborted && ctx.now().getTime() < ctx.deadline.getTime();

function parseCursor(cursor: string | null): Record<string, string> {
  if (!cursor) return {};
  try {
    const v = JSON.parse(cursor) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === 'string',
        ),
      );
    }
  } catch {
    // A cursor from another format: start over (re-landing an issue is a sha256 no-op).
  }
  return {};
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface LookupResult {
  /** Fields assigned a cell this run. */
  assigned: number;
  /** …of which by a /points call. */
  lookedUp: number;
  failed: number;
}

/** Step 1 (see the header). */
export async function lookupFieldGrids(ctx: JobContext, client: NwsClient): Promise<LookupResult> {
  const now = ctx.now();
  const out: LookupResult = { assigned: 0, lookedUp: 0, failed: 0 };
  // A few at a time: a first run on a new farm asks NWS about every field (~40 /points calls).
  await eachLimit(await fieldsNeedingGrid(ctx.pool, now), CONCURRENCY, async (p) => {
    if (!timeLeft(ctx)) return;
    try {
      let gridId = await cachedGridAt(ctx.pool, p.lng, p.lat, now);
      if (!gridId) {
        const point = await client.point(p.lng, p.lat);
        const grid = gridOfPoint(point);
        if (!(await gridIsFresh(ctx.pool, grid.id, now))) {
          const stations = await client.stations(grid, p);
          await upsertGrid(ctx.pool, grid, stations, point.properties.timeZone ?? null, now);
        }
        gridId = grid.id;
        out.lookedUp++;
      }
      await assignFieldGrid(ctx.pool, p, gridId, now);
      out.assigned++;
    } catch (e) {
      out.failed++;
      ctx.log.warn('weather grid lookup failed', { fieldId: p.fieldId, error: errorText(e) });
    }
  });
  return out;
}

/** NWS asks every app for a User-Agent with contact information (website or email). */
export function userAgentHasContact(ua: string): boolean {
  return /@|https?:\/\/|\.[a-z]{2,}\b/i.test(ua);
}

async function publishSyncStatus(result: SyncStepResult, sctx: SyncContext): Promise<void> {
  const r = await exec<{ last_ok_at: unknown; last_error: string | null }>(
    sctx.job.pool,
    'select last_ok_at, last_error from ingest.sync_state where source = $1 and stream = $2',
    [sctx.source, sctx.stream],
  );
  const row = r.rows[0];
  await publish(
    'admin',
    'sync.status',
    {
      source: sctx.source,
      stream: sctx.stream,
      mode: sctx.mode,
      ok: result.ok,
      lastOkAt: toDate(row?.last_ok_at ?? null)?.toISOString() ?? null,
      lastError: result.ok ? null : (result.error ?? row?.last_error ?? null),
    },
    sctx.job.pool,
  );
}

/**
 * Step 2: the forecast sync step's spec. `landed` collects the issues stored this run, `checked`
 * every cell NWS answered for (with the issue it served: new or the same one again).
 */
export function forecastSpec(
  ctx: JobContext,
  client: NwsClient,
  mode: WeatherConfig['CONNECTOR_WEATHER'],
  grids: readonly GridInUse[],
  landed: { gridId: string; issuedAt: string }[],
  partial: string[],
  checked: { gridId: string; issuedAt: string }[],
): SyncStepSpec<NwsGridpoint, ForecastItem> {
  return {
    source: NWS_SOURCE,
    stream: FORECAST_STREAM,
    mode,
    leaseSeconds: 120,
    async poll(cursor) {
      const seen = parseCursor(cursor);
      const next: Record<string, string> = {};
      const items: RawItem<NwsGridpoint>[] = [];
      const errors: string[] = [];
      await eachLimit(grids, CONCURRENCY, async (g) => {
        if (seen[g.id]) next[g.id] = seen[g.id] as string;
        if (!timeLeft(ctx)) return;
        try {
          const raw = await client.gridpoint(g);
          const issuedAt = new Date(Date.parse(raw.properties.updateTime)).toISOString();
          checked.push({ gridId: g.id, issuedAt });
          if (seen[g.id] === issuedAt) return;
          const start = Math.floor(Date.parse(issuedAt) / HOUR_MS) * HOUR_MS;
          items.push({
            externalId: `${g.id}@${issuedAt}`,
            payload: trimGridpoint(raw, {
              from: start - ISSUE_HOURS_BEFORE * HOUR_MS,
              to: start + ISSUE_DAYS_AFTER * 24 * HOUR_MS,
            }),
          });
          next[g.id] = issuedAt;
        } catch (e) {
          errors.push(`${g.id}: ${errorText(e)}`);
        }
      });
      if (errors.length && errors.length === grids.length) throw new Error(errors[0]);
      if (errors.length) {
        partial.push(`${errors.length} of ${grids.length} forecasts failed`);
        ctx.log.warn('some NWS forecasts failed', { errors });
      }
      items.sort((a, b) => a.externalId.localeCompare(b.externalId));
      return { items, cursor: JSON.stringify(next) };
    },
    map: (raw) => [{ issue: mapGridpoint(raw), cell: (raw.geometry as Polygon | null) ?? null }],
    async upsert(tx, item) {
      await insertForecastIssue(tx, item.issue, item.cell);
      landed.push({ gridId: item.issue.grid.id, issuedAt: item.issue.issuedAt });
    },
    afterRun: publishSyncStatus,
  };
}

/** Observations as landed: the properties the mapper reads (the rest is dropped). */
function trimObservation(f: NwsObservation): NwsObservation {
  const p = f.properties;
  return {
    type: 'Feature',
    geometry: f.geometry ?? null,
    properties: {
      ...(p.station ? { station: p.station } : {}),
      ...(p.stationId ? { stationId: p.stationId } : {}),
      ...(p.stationName ? { stationName: p.stationName } : {}),
      timestamp: p.timestamp,
      temperature: p.temperature ?? null,
      dewpoint: p.dewpoint ?? null,
      windDirection: p.windDirection ?? null,
      windSpeed: p.windSpeed ?? null,
      windGust: p.windGust ?? null,
      relativeHumidity: p.relativeHumidity ?? null,
      precipitationLastHour: p.precipitationLastHour ?? null,
    },
  };
}

/** Step 3: the observations sync step's spec (the nearest station of each cell). */
export function observationsSpec(
  ctx: JobContext,
  client: NwsClient,
  mode: WeatherConfig['CONNECTOR_WEATHER'],
  grids: readonly GridInUse[],
  partial: string[],
): SyncStepSpec<NwsObservation, Observation> {
  const stations = [
    ...new Set(grids.map((g) => g.stations[0]?.id).filter((s): s is string => !!s)),
  ].sort();
  return {
    source: NWS_SOURCE,
    stream: OBSERVATIONS_STREAM,
    mode,
    leaseSeconds: 120,
    async poll(cursor) {
      const seen = parseCursor(cursor);
      const next: Record<string, string> = { ...seen };
      const items: RawItem<NwsObservation>[] = [];
      const errors: string[] = [];
      const oldest = ctx.now().getTime() - OBSERVATION_LOOKBACK_MS;
      await eachLimit(stations, CONCURRENCY, async (id) => {
        if (!timeLeft(ctx)) return;
        const last = seen[id] ? Date.parse(seen[id] as string) : Number.NaN;
        const since = new Date(Number.isFinite(last) ? Math.max(last, oldest) : oldest);
        try {
          for (const f of await client.observationFeatures(id, since)) {
            const ts = new Date(Date.parse(f.properties.timestamp)).toISOString();
            items.push({ externalId: `${id}@${ts}`, payload: trimObservation(f) });
            if (!next[id] || Date.parse(next[id] as string) < Date.parse(ts)) next[id] = ts;
          }
        } catch (e) {
          errors.push(`${id}: ${errorText(e)}`);
        }
      });
      if (errors.length && errors.length === stations.length) throw new Error(errors[0]);
      if (errors.length) {
        partial.push(`${errors.length} of ${stations.length} stations failed`);
        ctx.log.warn('some NWS observations failed', { errors });
      }
      items.sort((a, b) => a.externalId.localeCompare(b.externalId));
      return { items, cursor: JSON.stringify(next) };
    },
    map: (raw) => [mapObservation(raw)],
    upsert: (tx, o) => upsertObservation(tx, o),
    afterRun: publishSyncStatus,
  };
}

/** Claim this UTC hour's pruning (at most once an hour); false when already done. */
async function claimPruneHour(ctx: JobContext, hour: string): Promise<boolean> {
  const r = await exec(
    ctx.pool,
    `update ingest.sync_state
        set extra = coalesce(extra, '{}'::jsonb) || jsonb_build_object('prunedHour', $3::text)
      where source = $1 and stream = $2 and coalesce(extra->>'prunedHour', '') <> $3`,
    [NWS_SOURCE, FORECAST_STREAM, hour],
  );
  return r.rowCount > 0;
}

async function recordPrune(
  ctx: JobContext,
  pruned: { forecasts: number; assessments: number; rawEvents: number; complete: boolean },
): Promise<void> {
  await exec(
    ctx.pool,
    `update ingest.sync_state
        set extra = coalesce(extra, '{}'::jsonb) || jsonb_build_object('pruned', $3::jsonb)
                    || case when $4::boolean then '{}'::jsonb else jsonb_build_object('prunedHour', '') end
      where source = $1 and stream = $2`,
    [
      NWS_SOURCE,
      FORECAST_STREAM,
      JSON.stringify({
        forecasts: pruned.forecasts,
        assessments: pruned.assessments,
        rawEvents: pruned.rawEvents,
      }),
      pruned.complete,
    ],
  );
}

/** Step 4 + its realtime, in one transaction (published on commit). */
async function sprayPass(ctx: JobContext): Promise<SprayPassResult> {
  const setting = await readSprayThresholds(ctx.pool);
  return ctx.db.transaction(async (tx) => {
    const pass = await runSprayPass(tx, ctx.now(), setting.thresholds);
    if (pass.written > 0) {
      await publish(
        'spray',
        'assessed',
        { forHour: pass.forHour, fieldIds: pass.fieldIds, counts: pass.counts },
        tx,
      );
    }
    if (pass.changedFieldIds.length > FIELD_UPDATE_LIMIT) {
      await publish('fields', 'invalidate', { event: 'updated', reason: 'changed' }, tx);
    } else {
      for (const fieldId of pass.changedFieldIds) {
        await publish('fields', 'updated', { fieldId, parts: ['spray'] }, tx);
      }
    }
    return pass;
  });
}

export function createWeatherNwsJob(opts: WeatherJobOptions = {}) {
  return async function runWeatherNws(ctx: JobContext): Promise<JobResult> {
    const cfg = (opts.config ?? getConfig)();
    const mode = cfg.CONNECTOR_WEATHER;
    if (mode === 'off') return { items: 0, note: 'off' };
    const client = NwsClient.forMode(mode, cfg, {
      signal: ctx.signal,
      deadline: ctx.deadline,
      now: () => ctx.now(),
      ...opts.http,
    });
    const partial: string[] = [];
    if ((mode === 'live' || mode === 'sandbox') && !userAgentHasContact(cfg.NWS_USER_AGENT)) {
      ctx.log.warn(
        'NWS_USER_AGENT has no contact info: NWS asks for one, e.g. "farm-manager (you@example.com)"',
      );
    }

    const dropped = await switchGridSource(ctx.pool, gridSourceOf(mode));
    if (dropped) {
      ctx.log.info('weather source changed: cached grid cells dropped, looking them up again', {
        dropped,
        source: gridSourceOf(mode),
      });
    }
    const lookups = await lookupFieldGrids(ctx, client);
    if (lookups.failed) partial.push(`${lookups.failed} grid lookups failed`);
    const grids = await gridsInUse(ctx.pool);

    const landed: { gridId: string; issuedAt: string }[] = [];
    const checked: { gridId: string; issuedAt: string }[] = [];
    const forecast = await runSyncStep(
      forecastSpec(ctx, client, mode, grids, landed, partial, checked),
      ctx,
    );
    // The cells NWS answered for are current as of now (the spray pass below and every view
    // count staleness from here). Not when the step failed or another run held it.
    if (forecast.claimed && forecast.ok) {
      await markForecastsChecked(ctx.pool, checked, ctx.now());
    }
    let observations: SyncStepResult | null = null;
    if (timeLeft(ctx)) {
      observations = await runSyncStep(observationsSpec(ctx, client, mode, grids, partial), ctx);
    }

    if (landed.length || (observations?.processed ?? 0) > 0) {
      const newest =
        landed
          .map((l) => l.issuedAt)
          .sort()
          .at(-1) ?? null;
      await publish(
        'weather',
        'updated',
        { gridIds: [...new Set(landed.map((l) => l.gridId))].sort(), issuedAt: newest },
        ctx.pool,
      );
    }

    const pass = await sprayPass(ctx);

    const hour = new Date(Math.floor(ctx.now().getTime() / HOUR_MS) * HOUR_MS).toISOString();
    if (timeLeft(ctx) && (await claimPruneHour(ctx, hour))) {
      const pruned = await pruneWeather(ctx.pool, ctx.now(), ctx.deadline, {
        clock: () => ctx.now().getTime(),
      });
      await recordPrune(ctx, pruned);
      if (pruned.forecasts + pruned.assessments + pruned.rawEvents > 0) {
        ctx.log.info('weather retention', { ...pruned });
      }
    }

    const failed = [forecast, observations].find((r) => r?.claimed && !r.ok);
    if (failed) throw new SyncStepError(failed);
    const notes = [
      `${grids.length} cells`,
      `${landed.length} new forecasts`,
      `${observations?.processed ?? 0} observations`,
      `${pass.written} assessments (${pass.counts.go} go, ${pass.counts.caution} caution, ${pass.counts.noGo} no-go)`,
      ...partial,
    ];
    if (!forecast.claimed) notes.push(`forecast: ${forecast.skipped ?? 'not claimed'}`);
    return {
      items: forecast.processed + (observations?.processed ?? 0) + pass.written,
      note: notes.join('; '),
    };
  };
}

export const runWeatherNws = createWeatherNwsJob();
