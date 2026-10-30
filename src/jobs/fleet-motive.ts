/**
 * fleet.motive (slice 1f.2; owner: the trucks builder, docs/contracts-1f.md part B): Motive
 * vehicle positions (CONNECTOR_MOTIVE) → farm.positions + machine_state, one batched
 * `fleet`/`tick` per claimed run. Moved out of fleet.trucks by the foundation when every vendor
 * got its own mode key: the 1a placeholder client (current locations, per-vehicle watermark
 * cursor: the snapshot-diff sync model) as it was. The trucks builder adds stats
 * (true_engine_hours / true_odometer) and `/v1/fault_codes` as streams of this job.
 */
import { getConfig } from '../config';
import { MotiveClient, mapMotivePosition } from '../connectors/motive/client';
import type { MotivePositionRaw } from '../connectors/motive/schemas';
import { runSyncStep } from '../connectors/sync-step';
import { type NormalizedPosition, type SyncStepSpec, syncStepJobResult } from '../connectors/types';
import { staleThresholdsOf } from '../db/queries/fleet';
import {
  type FleetJobOptions,
  httpFor,
  machineResolver,
  positionsUpsert,
  tickAfterRun,
} from './fleet-shared';
import type { JobContext, JobResult } from './types';

export const MOTIVE_POSITIONS_STREAM = 'positions';
/** Same cadence and budget as fleet.trucks: every 30 s, 25 s budget, a 60 s stream lease. */
export const MOTIVE_BUDGET_MS = 25_000;
export const MOTIVE_LEASE_SECONDS = 60;

export function createFleetMotiveJob(opts: FleetJobOptions = {}) {
  return async function runFleetMotive(ctx: JobContext): Promise<JobResult> {
    const cfg = (opts.config ?? getConfig)();
    const mode = cfg.CONNECTOR_MOTIVE;
    const http = httpFor(ctx, opts.http);
    let client: MotiveClient | null = null;
    const spec: SyncStepSpec<MotivePositionRaw, NormalizedPosition> = {
      source: 'motive',
      stream: MOTIVE_POSITIONS_STREAM,
      mode,
      leaseSeconds: MOTIVE_LEASE_SECONDS,
      poll: (cursor) => {
        client ??= MotiveClient.forMode(mode, cfg, http);
        return client.pollPositions(cursor);
      },
      map: (raw) => mapMotivePosition(raw),
      upsert: positionsUpsert(machineResolver()),
      afterRun: tickAfterRun(staleThresholdsOf(cfg)),
    };
    return syncStepJobResult(await runSyncStep(spec, ctx));
  };
}

export const runFleetMotive = createFleetMotiveJob();
