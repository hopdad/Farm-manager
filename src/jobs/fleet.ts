/**
 * The fleet.* jobs (plan §5 per-source table, contracts §5/§7/§8):
 *
 *   fleet.trucks  ELD positions (ELD_VENDOR: samsara | motive) → farm.positions + machine_state,
 *                 then Samsara engine hours / odometer / fuel (stats feed)
 *   fleet.deere   Deere breadcrumbs (working machines only) → the same tables
 *
 * Each claimed positions run publishes ONE batched `fleet`/`tick` built from
 * farm.machine_state with `stale` recomputed (also when the poll failed, so "trucks API down"
 * turns the trucks stale on the board), plus an `admin`/`sync.status` per claimed step.
 * Vendor ids map to machines through ingest.external_refs (seeded by `simExternalRefs`);
 * unmapped vehicles are skipped and logged, never invented.
 *
 * M1 1a: every NEW fix also runs geofence enter/exit detection in the same per-event
 * transaction (./geofences.ts → farm.geofence_visits), and `replay` mode (CONNECTOR_DEERE /
 * CONNECTOR_ELD=replay) runs the same clients on the doc-derived fixtures, time-shifted to now
 * (Samsara through SamsaraClient.forMode, Deere through DeereClient.forReplay: no OAuth).
 *
 * Slice 1f (docs/contracts-1f.md §1): this file is fleet.trucks (fleet-faults builder: the
 * Samsara `faults` stream joins here); fleet.deere moved to ./fleet-deere.ts (sync-health) and
 * the shared pieces to ./fleet-shared.ts. Both are re-exported below, so imports of './fleet'
 * keep working.
 */
import { getConfig } from '../config';
import { MotiveClient, mapMotivePosition } from '../connectors/motive/client';
import type { MotivePositionRaw } from '../connectors/motive/schemas';
import { SamsaraClient } from '../connectors/samsara/client';
import { mapSamsaraPosition, mapSamsaraStat } from '../connectors/samsara/mapper';
import type { SamsaraPositionRaw, SamsaraStatRaw } from '../connectors/samsara/schemas';
import { runSyncStep } from '../connectors/sync-step';
import {
  type NormalizedPosition,
  type NormalizedVehicleStat,
  type SyncContext,
  SyncStepError,
  type SyncStepResult,
  type SyncStepSpec,
  syncStepJobResult,
} from '../connectors/types';
import type { Executor } from '../db/exec';
import { staleThresholdsOf, upsertVehicleStat } from '../db/queries/fleet';
import {
  type FleetJobOptions,
  httpFor,
  machineResolver,
  positionsUpsert,
  publishSyncStatus,
  tickAfterRun,
} from './fleet-shared';
import type { JobContext, JobResult } from './types';

export { createFleetDeereJob, DEERE_STREAM, runFleetDeere } from './fleet-deere';
export type { FleetConfig, FleetJobOptions } from './fleet-shared';

export const TRUCKS_STREAM = 'positions';
export const STATS_STREAM = 'stats';
/** fleet.trucks runs every 30 s with a 25 s budget; its stream lease must outlive the budget. */
export const TRUCKS_BUDGET_MS = 25_000;
export const TRUCKS_LEASE_SECONDS = 60;

function statsUpsert(resolve: ReturnType<typeof machineResolver>) {
  return async (tx: Executor, s: NormalizedVehicleStat, sctx: SyncContext): Promise<void> => {
    const id = await resolve(tx, sctx, s.source, s.sourceOrg, s.externalMachineId);
    if (id) await upsertVehicleStat(tx, id, s);
  };
}

/** Several steps → one JobResult: the first failed step throws; else processed items add up. */
export function combineStepResults(primary: SyncStepResult, others: SyncStepResult[]): JobResult {
  const failed = [primary, ...others].find((r) => r.claimed && !r.ok);
  if (failed) throw new SyncStepError(failed);
  if (!primary.claimed) {
    const extra = others.reduce((n, r) => n + r.processed, 0);
    return { ...syncStepJobResult(primary), items: extra };
  }
  const all = [primary, ...others];
  const dead = all.reduce((n, r) => n + r.dead, 0);
  const items = all.reduce((n, r) => n + r.processed, 0);
  return dead > 0 ? { items, note: `${dead} dead-lettered` } : { items };
}

export function createFleetTrucksJob(opts: FleetJobOptions = {}) {
  return async function runFleetTrucks(ctx: JobContext): Promise<JobResult> {
    const cfg = (opts.config ?? getConfig)();
    const vendor = cfg.ELD_VENDOR;
    const mode = cfg.CONNECTOR_ELD;
    const http = httpFor(ctx, opts.http);
    const resolve = machineResolver();
    const tick = tickAfterRun(staleThresholdsOf(cfg));

    let positions: SyncStepResult;
    const others: SyncStepResult[] = [];
    if (vendor === 'samsara') {
      let client: SamsaraClient | null = null;
      const samsara = () => {
        client ??= SamsaraClient.forMode(mode, cfg, http);
        return client;
      };
      const posSpec: SyncStepSpec<SamsaraPositionRaw, NormalizedPosition> = {
        source: 'samsara',
        stream: TRUCKS_STREAM,
        mode,
        leaseSeconds: TRUCKS_LEASE_SECONDS,
        poll: (cursor) => samsara().pollPositions(cursor),
        map: (raw) => mapSamsaraPosition(raw),
        upsert: positionsUpsert(resolve),
        afterRun: tick,
      };
      positions = await runSyncStep(posSpec, ctx);
      const statsSpec: SyncStepSpec<SamsaraStatRaw, NormalizedVehicleStat> = {
        source: 'samsara',
        stream: STATS_STREAM,
        mode,
        leaseSeconds: TRUCKS_LEASE_SECONDS,
        poll: (cursor) => samsara().pollStats(cursor),
        map: (raw) => mapSamsaraStat(raw),
        upsert: statsUpsert(resolve),
        afterRun: publishSyncStatus,
      };
      // Positions first (they feed the tick); stats only while budget remains.
      if (ctx.now().getTime() < ctx.deadline.getTime() && !ctx.signal.aborted) {
        others.push(await runSyncStep(statsSpec, ctx));
      }
    } else {
      let client: MotiveClient | null = null;
      const spec: SyncStepSpec<MotivePositionRaw, NormalizedPosition> = {
        source: 'motive',
        stream: TRUCKS_STREAM,
        mode,
        leaseSeconds: TRUCKS_LEASE_SECONDS,
        poll: (cursor) => {
          client ??= MotiveClient.forMode(mode, cfg, http);
          return client.pollPositions(cursor);
        },
        map: (raw) => mapMotivePosition(raw),
        upsert: positionsUpsert(resolve),
        afterRun: tick,
      };
      positions = await runSyncStep(spec, ctx);
    }
    return combineStepResults(positions, others);
  };
}

export const runFleetTrucks = createFleetTrucksJob();
