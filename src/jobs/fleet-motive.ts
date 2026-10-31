/**
 * fleet.motive (slice 1f.2; the trucks builder, docs/contracts-1f.md part B §B.4.8): Motive
 * (CONNECTOR_MOTIVE) through the vehicle telematics port, one stream per port method, every
 * 30 s (5 s demo) within a 25 s budget:
 *
 *   positions  v3 (Vehicle Gateway units) + v2 current locations → farm.positions +
 *              machine_state (vendor id `motive`), then ONE batched `fleet`/`tick`
 *   stats      v2 current_location: true_engine_hours / true_odometer (adjusted) else the raw
 *              ones, fuel % → machines (never decreasing) + machine_state (statsUpsert)
 *   faults     /v1/fault_codes as `delta` reports (open/closed with first/last observed)
 *              through the same statsUpsert (fleet-faults' writer stores them)
 *   vehicles   /v1/vehicles + group names → kind (VEHICLE_KIND_TAGS; an admin-set kind wins)
 *              with applyVendorVehicle, at most hourly; `fleet`/`invalidate` when one changed
 *
 * Vehicles map through ingest.external_refs: ('motive', 'machine', <vehicle id>, <company id>)
 * first, then the company-less ref ('' source_org) a database seeded before the 1f merge still
 * has (until `pnpm db:seed demo`, §B.4.1); an unmapped vehicle is left out before landing (`only`), never
 * created. Positions first (they feed the tick); the other streams only while budget remains.
 */
import { getConfig } from '../config';
import { MotiveClient } from '../connectors/motive/client';
import {
  mapMotiveFault,
  mapMotivePosition,
  mapMotiveStat,
  mapMotiveVehicle,
} from '../connectors/motive/mapper';
import type {
  MotiveFaultRaw,
  MotivePositionRaw,
  MotiveStatRaw,
  MotiveVehicleRaw,
} from '../connectors/motive/schemas';
import { runSyncStep } from '../connectors/sync-step';
import type {
  NormalizedPosition,
  NormalizedVehicle,
  NormalizedVehicleStat,
  SyncStepResult,
  SyncStepSpec,
} from '../connectors/types';
import { allMappedIds, mappedVehicleRefs, vehicleListUpsert } from '../connectors/vehicles/refs';
import { staleThresholdsOf } from '../db/queries/fleet';
import { combineStepResults, statsUpsert } from './fleet';
import {
  type FleetJobOptions,
  httpFor,
  machineResolver,
  positionsUpsert,
  publishSyncStatus,
  tickAfterRun,
} from './fleet-shared';
import type { JobContext, JobResult } from './types';

export const MOTIVE_POSITIONS_STREAM = 'positions';
export const MOTIVE_STATS_STREAM = 'stats';
export const MOTIVE_FAULTS_STREAM = 'faults';
export const MOTIVE_VEHICLES_STREAM = 'vehicles';
/** Same cadence and budget as fleet.trucks: every 30 s, 25 s budget, a 60 s stream lease. */
export const MOTIVE_BUDGET_MS = 25_000;
export const MOTIVE_LEASE_SECONDS = 60;
/** The vehicle list (kinds) changes rarely: at most hourly (the first run reads it at once). */
export const VEHICLE_LIST_MIN_INTERVAL_SECONDS = 3_600;

export function createFleetMotiveJob(opts: FleetJobOptions = {}) {
  return async function runFleetMotive(ctx: JobContext): Promise<JobResult> {
    const cfg = (opts.config ?? getConfig)();
    const mode = cfg.CONNECTOR_MOTIVE;
    const http = httpFor(ctx, opts.http);
    const resolve = machineResolver({ orgFallback: true });
    let client: MotiveClient | null = null;
    const motive = async () => {
      if (!client) {
        const only = allMappedIds(await mappedVehicleRefs(ctx.pool, 'motive'));
        client = MotiveClient.forMode(mode, cfg, http, {
          only,
          log: (msg, data) => ctx.log.warn(msg, data),
        });
      }
      return client;
    };
    const step = { source: 'motive' as const, mode, leaseSeconds: MOTIVE_LEASE_SECONDS };

    const posSpec: SyncStepSpec<MotivePositionRaw, NormalizedPosition> = {
      ...step,
      stream: MOTIVE_POSITIONS_STREAM,
      poll: async (cursor) => (await motive()).pollPositions(cursor),
      map: (raw) => mapMotivePosition(raw),
      upsert: positionsUpsert(resolve, staleThresholdsOf(cfg)),
      afterRun: tickAfterRun(staleThresholdsOf(cfg)),
    };
    const statsSpec: SyncStepSpec<MotiveStatRaw, NormalizedVehicleStat> = {
      ...step,
      stream: MOTIVE_STATS_STREAM,
      poll: async (cursor) => (await motive()).pollStats(cursor),
      map: (raw) => mapMotiveStat(raw),
      upsert: statsUpsert(resolve),
      afterRun: publishSyncStatus,
    };
    const faultsSpec: SyncStepSpec<MotiveFaultRaw, NormalizedVehicleStat> = {
      ...step,
      stream: MOTIVE_FAULTS_STREAM,
      poll: async (cursor) => (await motive()).pollFaults(cursor),
      map: (raw) => mapMotiveFault(raw),
      upsert: statsUpsert(resolve),
      afterRun: publishSyncStatus,
    };
    const vehicles = vehicleListUpsert(resolve, publishSyncStatus);
    const vehiclesSpec: SyncStepSpec<MotiveVehicleRaw, NormalizedVehicle> = {
      ...step,
      stream: MOTIVE_VEHICLES_STREAM,
      minIntervalSeconds: VEHICLE_LIST_MIN_INTERVAL_SECONDS,
      poll: async (cursor) => (await motive()).pollVehicles(cursor),
      map: (raw) => mapMotiveVehicle(raw, cfg.VEHICLE_KIND_TAGS),
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

export const runFleetMotive = createFleetMotiveJob();
