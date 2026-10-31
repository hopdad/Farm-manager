/**
 * fleet.geotab (slice 1f.2; the trucks builder, docs/contracts-1f.md part B §B.4.8): MyGeotab
 * (CONNECTOR_GEOTAB) through the vehicle telematics port, every 30 s (10 s demo) within a 25 s
 * budget, ONE toVersion cursor per entity type (the cursor/version sync model):
 *
 *   positions  GetFeed LogRecord → farm.positions + machine_state (vendor id `geotab`), then ONE
 *              batched `fleet`/`tick` (a limited-scope user: Get DeviceStatusInfo, last known)
 *   stats      GetFeed StatusData, filtered to our diagnostics before landing: engine hours,
 *              odometer, fuel, DEF, ignition → machines (never decreasing) + machine_state
 *   faults     GetFeed FaultData (J1939 / OBD-II / proprietary, decoded with the Diagnostic and
 *              FailureMode lookups) as `delta` reports through statsUpsert
 *   vehicles   Get Device + Group names → kind (VEHICLE_KIND_TAGS) with applyVendorVehicle, at
 *              most hourly
 *
 * One session per service user, reused across runs: kept in ingest.oauth_tokens (source
 * `geotab`, encrypted with TOKEN_ENC_KEY; in sim without a key, in this process). GetFeed stays
 * within 60/min per entity type and Authenticate within 10/min (./connectors/geotab/session.ts).
 * When the limited-scope fallback serves a stream, its sync_state.extra says so
 * (`scopeFallback: 1`, shown on /admin/connectors as a counter; 0 once GetFeed works again; no
 * key on a stream that never fell back).
 * Devices the farm doesn't map never land (`only`). Positions first; the rest while budget
 * remains.
 */
import { getConfig } from '../config';
import { geotabEndpoint } from '../connectors/endpoints';
import { GeotabClient } from '../connectors/geotab/client';
import {
  mapGeotabFault,
  mapGeotabPosition,
  mapGeotabStat,
  mapGeotabVehicle,
} from '../connectors/geotab/mapper';
import type {
  GeotabFaultRaw,
  GeotabPositionRaw,
  GeotabStatRaw,
  GeotabVehicleRaw,
} from '../connectors/geotab/schemas';
import { geotabSessionOrg } from '../connectors/geotab/session';
import { tokenKey } from '../connectors/oauth/crypto';
import { OAuthTokenStore, type TokenStore } from '../connectors/oauth/token-store';
import { runSyncStep } from '../connectors/sync-step';
import type {
  Mode,
  NormalizedPosition,
  NormalizedVehicle,
  NormalizedVehicleStat,
  SyncContext,
  SyncStepResult,
  SyncStepSpec,
} from '../connectors/types';
import { exec } from '../db/exec';
import { staleThresholdsOf } from '../db/queries/fleet';
import { combineStepResults, statsUpsert } from './fleet';
import {
  mappedVehicleIds,
  scopedMachineResolver,
  VEHICLE_LIST_MIN_INTERVAL_SECONDS,
  vehiclesUpsert,
} from './fleet-motive';
import {
  type FleetConfig,
  type FleetJobOptions,
  httpFor,
  positionsUpsert,
  publishSyncStatus,
  tickAfterRun,
} from './fleet-shared';
import type { JobContext, JobResult } from './types';

export const GEOTAB_POSITIONS_STREAM = 'positions';
export const GEOTAB_STATS_STREAM = 'stats';
export const GEOTAB_FAULTS_STREAM = 'faults';
export const GEOTAB_VEHICLES_STREAM = 'vehicles';
export const GEOTAB_BUDGET_MS = 25_000;
export const GEOTAB_LEASE_SECONDS = 60;

export interface FleetGeotabJobOptions extends FleetJobOptions {
  /** Where the session lives (tests); default: ingest.oauth_tokens through OAuthTokenStore. */
  sessionStore?: (ctx: JobContext, cfg: FleetConfig, mode: Mode) => TokenStore | null;
}

/** The session store of a run: OAuthTokenStore (source 'geotab'), or null = per process. */
export function geotabSessionStore(
  ctx: JobContext,
  cfg: FleetConfig,
  mode: Mode,
): TokenStore | null {
  if (mode === 'replay' || mode === 'off') return null;
  // Sim needs no secret: without TOKEN_ENC_KEY the stand-in's session lives in this process.
  if (mode === 'sim' && !cfg.TOKEN_ENC_KEY) return null;
  return new OAuthTokenStore({
    pool: ctx.pool,
    source: 'geotab',
    org: geotabSessionOrg(geotabEndpoint(mode, cfg)),
    key: tokenKey(cfg.TOKEN_ENC_KEY),
    now: () => ctx.now(),
  });
}

/**
 * Merge `scopeFallback` into the stream's extra: 1 while the limited-scope fallback serves it,
 * back to 0 once GetFeed works again (a stream that never fell back gets no key at all).
 */
async function noteFallback(sctx: SyncContext, on: boolean): Promise<void> {
  await exec(
    sctx.job.pool,
    `update ingest.sync_state
        set extra = coalesce(extra, '{}'::jsonb) || jsonb_build_object('scopeFallback', $3::int)
      where source = $1 and stream = $2
        and ($3::int = 1 or coalesce(extra, '{}'::jsonb) ? 'scopeFallback')`,
    [sctx.source, sctx.stream, on ? 1 : 0],
  );
}

export function createFleetGeotabJob(opts: FleetGeotabJobOptions = {}) {
  return async function runFleetGeotab(ctx: JobContext): Promise<JobResult> {
    const cfg = (opts.config ?? getConfig)();
    const mode = cfg.CONNECTOR_GEOTAB ?? 'off';
    const http = httpFor(ctx, opts.http);
    const resolve = scopedMachineResolver();
    let client: GeotabClient | null = null;
    const geotab = async () => {
      if (!client) {
        const only = await mappedVehicleIds(ctx.pool, 'geotab');
        const store = (opts.sessionStore ?? geotabSessionStore)(ctx, cfg, mode);
        client = GeotabClient.forMode(mode, cfg, http, {
          store,
          only,
          log: (msg, data) => ctx.log.warn(msg, data),
        });
      }
      return client;
    };
    const step = { source: 'geotab' as const, mode, leaseSeconds: GEOTAB_LEASE_SECONDS };
    const tick = tickAfterRun(staleThresholdsOf(cfg));

    const posSpec: SyncStepSpec<GeotabPositionRaw, NormalizedPosition> = {
      ...step,
      stream: GEOTAB_POSITIONS_STREAM,
      poll: async (cursor) => (await geotab()).pollPositions(cursor),
      map: (raw) => mapGeotabPosition(raw),
      upsert: positionsUpsert(resolve, staleThresholdsOf(cfg)),
      afterRun: async (result, sctx) => {
        if (result.ok && client) await noteFallback(sctx, client.fallbacks.has('positions'));
        await tick(result, sctx);
      },
    };
    const statsSpec: SyncStepSpec<GeotabStatRaw, NormalizedVehicleStat> = {
      ...step,
      stream: GEOTAB_STATS_STREAM,
      poll: async (cursor) => (await geotab()).pollStats(cursor),
      map: (raw) => mapGeotabStat(raw),
      upsert: statsUpsert(resolve),
      afterRun: async (result, sctx) => {
        if (result.ok && client) await noteFallback(sctx, client.fallbacks.has('stats'));
        await publishSyncStatus(result, sctx);
      },
    };
    const faultsSpec: SyncStepSpec<GeotabFaultRaw, NormalizedVehicleStat> = {
      ...step,
      stream: GEOTAB_FAULTS_STREAM,
      poll: async (cursor) => (await geotab()).pollFaults(cursor),
      map: (raw) => mapGeotabFault(raw),
      upsert: statsUpsert(resolve),
      afterRun: publishSyncStatus,
    };
    const vehicles = vehiclesUpsert(resolve);
    const vehiclesSpec: SyncStepSpec<GeotabVehicleRaw, NormalizedVehicle> = {
      ...step,
      stream: GEOTAB_VEHICLES_STREAM,
      minIntervalSeconds: VEHICLE_LIST_MIN_INTERVAL_SECONDS,
      poll: async (cursor) => (await geotab()).pollVehicles(cursor),
      map: (raw) => mapGeotabVehicle(raw, cfg.VEHICLE_KIND_TAGS),
      upsert: vehicles.upsert,
      afterRun: vehicles.afterRun,
    };

    const positions = await runSyncStep(posSpec, ctx);
    const others: SyncStepResult[] = [];
    for (const spec of [statsSpec, faultsSpec, vehiclesSpec] as SyncStepSpec<unknown, unknown>[]) {
      if (ctx.now().getTime() >= ctx.deadline.getTime() || ctx.signal.aborted) break;
      others.push(await runSyncStep(spec, ctx));
    }
    return combineStepResults(positions, others);
  };
}

export const runFleetGeotab = createFleetGeotabJob();
