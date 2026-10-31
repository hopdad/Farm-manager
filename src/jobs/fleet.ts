/**
 * The fleet.* jobs (plan §5 per-source table, contracts §5/§7/§8):
 *
 *   fleet.trucks  Samsara vehicle positions (CONNECTOR_SAMSARA; the trucks and, 1f.2, the
 *                 pickups on Samsara's carmaker-cloud integrations) → farm.positions +
 *                 machine_state, then Samsara engine hours / odometer / fuel (stats feed), then
 *                 (1f) Samsara fault codes (stream `faults`: the faultCodes stats type, its own
 *                 cursor) → farm.machine_faults + machine_state.fault_codes
 *   fleet.deere   Deere breadcrumbs (working machines only) → the same tables
 *   (1f.2: every other telematics connection has its own job: fleet.motive, fleet.geotab,
 *   fleet.equipment, fleet.aemp, fleet.cnh, fleet.terminal; src/jobs/registry.ts)
 *
 * Each claimed positions run publishes ONE batched `fleet`/`tick` built from
 * farm.machine_state with `stale` recomputed (also when the poll failed, so "trucks API down"
 * turns the trucks stale on the board), plus an `admin`/`sync.status` per claimed step.
 * Vendor ids map to machines through ingest.external_refs (seeded by `simExternalRefs`);
 * unmapped vehicles are skipped and logged, never invented.
 *
 * M1 1a: every NEW fix also runs geofence enter/exit detection in the same per-event
 * transaction (./geofences.ts → farm.geofence_visits), and `replay` mode (CONNECTOR_DEERE /
 * CONNECTOR_SAMSARA=replay) runs the same clients on the doc-derived fixtures, time-shifted to now
 * (Samsara through SamsaraClient.forMode, Deere through DeereClient.forReplay: no OAuth).
 *
 * Slice 1f (docs/contracts-1f.md §1): this file is fleet.trucks (fleet-faults builder: the
 * Samsara `faults` stream joins here); fleet.deere moved to ./fleet-deere.ts (sync-health) and
 * the shared pieces to ./fleet-shared.ts. Both are re-exported below, so imports of './fleet'
 * keep working.
 */
import { getConfig } from '../config';
import { SamsaraClient } from '../connectors/samsara/client';
import { mapSamsaraFaults, mapSamsaraPosition, mapSamsaraStat } from '../connectors/samsara/mapper';
import type {
  SamsaraFaultRaw,
  SamsaraPositionRaw,
  SamsaraStatRaw,
} from '../connectors/samsara/schemas';
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
export { createFleetMotiveJob, runFleetMotive } from './fleet-motive';
export type { FleetConfig, FleetJobOptions } from './fleet-shared';

export const TRUCKS_STREAM = 'positions';
export const STATS_STREAM = 'stats';
/** 1f: Samsara fault codes (WEBHOOK_NUDGES.samsara names it too). */
export const FAULTS_STREAM = 'faults';
/** fleet.trucks runs every 30 s with a 25 s budget; its stream lease must outlive the budget. */
export const TRUCKS_BUDGET_MS = 25_000;
export const TRUCKS_LEASE_SECONDS = 60;

export function statsUpsert(resolve: ReturnType<typeof machineResolver>) {
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
    const mode = cfg.CONNECTOR_SAMSARA;
    const http = httpFor(ctx, opts.http);
    const resolve = machineResolver();
    const tick = tickAfterRun(staleThresholdsOf(cfg));

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
    const positions = await runSyncStep(posSpec, ctx);
    const others: SyncStepResult[] = [];
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
    const faultsSpec: SyncStepSpec<SamsaraFaultRaw, NormalizedVehicleStat> = {
      source: 'samsara',
      stream: FAULTS_STREAM,
      mode,
      leaseSeconds: TRUCKS_LEASE_SECONDS,
      poll: (cursor) => samsara().pollFaults(cursor),
      map: (raw) => mapSamsaraFaults(raw),
      upsert: statsUpsert(resolve),
      afterRun: publishSyncStatus,
    };
    // Positions first (they feed the tick); stats, then fault codes, only while budget remains.
    const budgetLeft = () => ctx.now().getTime() < ctx.deadline.getTime() && !ctx.signal.aborted;
    if (budgetLeft()) others.push(await runSyncStep(statsSpec, ctx));
    if (budgetLeft()) others.push(await runSyncStep(faultsSpec, ctx));
    return combineStepResults(positions, others);
  };
}

export const runFleetTrucks = createFleetTrucksJob();
