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
 * first, then the 1a seed's company-less ref ('' source_org: H1's until the integrator moves it
 * under the company id, §B.4.1); an unmapped vehicle is left out before landing (`only`), never
 * created. Positions first (they feed the tick); the other streams only while budget remains.
 * The helpers below the job are shared with fleet.geotab (./fleet-geotab.ts).
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
import {
  type ConnectorSource,
  externalRefKey,
  type NormalizedPosition,
  type NormalizedVehicle,
  type NormalizedVehicleStat,
  type SyncContext,
  type SyncStepResult,
  type SyncStepSpec,
} from '../connectors/types';
import { type Executor, exec } from '../db/exec';
import { resolveExternalRefs } from '../db/external-refs';
import { staleThresholdsOf } from '../db/queries/fleet';
import { applyVendorVehicle } from '../db/queries/vehicles';
import { publish } from '../platform/realtime/publish';
import { combineStepResults, statsUpsert } from './fleet';
import {
  type FleetJobOptions,
  httpFor,
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
    const resolve = scopedMachineResolver();
    let client: MotiveClient | null = null;
    const motive = async () => {
      if (!client) {
        const only = await mappedVehicleIds(ctx.pool, 'motive');
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
    const vehicles = vehiclesUpsert(resolve);
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

// ---------------------------------------------------------------------------------------------
// Shared with fleet.geotab
// ---------------------------------------------------------------------------------------------

/**
 * Vendor vehicle id → farm.machines.id, cached per run: the ref under the item's sourceOrg (the
 * Motive company id) first, then the company-less ref ('' source_org) the 1a seed wrote, so H1
 * keeps mapping before and after the integrator moves its ref. Unmapped = null, logged once.
 * (Same signature as fleet-shared's machineResolver, so positionsUpsert/statsUpsert take it.)
 */
export function scopedMachineResolver() {
  const cache = new Map<string, string | null>();
  return async (
    ex: Executor,
    sctx: SyncContext,
    source: ConnectorSource,
    sourceOrg: string,
    externalId: string,
  ): Promise<string | null> => {
    const key = externalRefKey(source, 'machine', externalId, sourceOrg);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let id = (await resolveExternalRefs(ex, source, 'machine', sourceOrg, [externalId])).get(
      externalId,
    );
    if (!id && sourceOrg !== '') {
      id = (await resolveExternalRefs(ex, source, 'machine', '', [externalId])).get(externalId);
    }
    cache.set(key, id ?? null);
    if (!id) {
      sctx.job.log.info('unmapped vendor machine (no ingest.external_refs row); skipped', {
        source,
        sourceOrg,
        externalId,
      });
    }
    return id ?? null;
  };
}

/**
 * The vendor vehicle ids the farm maps (external refs of kind 'machine', any source_org): the
 * clients leave every other vehicle out before landing, so a hired hauler's whole fleet never
 * lands in ingest.raw_events.
 */
export async function mappedVehicleIds(
  ex: Executor,
  source: ConnectorSource,
): Promise<Set<string>> {
  const r = await exec<{ external_id: string }>(
    ex,
    `select external_id from ingest.external_refs where source = $1 and kind = 'machine'`,
    [source],
  );
  return new Set(r.rows.map((row) => row.external_id));
}

/**
 * The vehicle-list stream's upsert (kind from tags, via) and afterRun: ONE
 * `fleet`/`invalidate` { event: 'machine', reason: 'changed' } per run when any machine changed,
 * then the stream's sync status.
 */
export function vehiclesUpsert(resolve: ReturnType<typeof scopedMachineResolver>) {
  let changed = false;
  return {
    upsert: async (tx: Executor, v: NormalizedVehicle, sctx: SyncContext): Promise<void> => {
      const id = await resolve(tx, sctx, v.source, v.sourceOrg, v.externalId);
      if (!id) return;
      const r = await applyVendorVehicle(tx, id, { kindFromTags: v.kindFromTags, via: v.via });
      if (r?.changed) changed = true;
    },
    afterRun: async (result: SyncStepResult, sctx: SyncContext): Promise<void> => {
      if (changed) {
        changed = false;
        await publish(
          'fleet',
          'invalidate',
          { event: 'machine', reason: 'changed' },
          sctx.job.pool,
        );
      }
      await publishSyncStatus(result, sctx);
    },
  };
}
