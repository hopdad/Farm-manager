/**
 * fleet.equipment (slice 1f.2; owner: the machines builder, docs/contracts-1f.md part B §B.4.8):
 * Samsara's equipment feeds (CONNECTOR_SAMSARA) for machines on Samsara asset gateways (the
 * demo's RoGator SP2, `telematics_via` gateway, written by the seed):
 *
 *   samsara / equipment_positions  /fleet/equipment/locations/feed → LIVE fixes (farm.positions +
 *                                  machine_state, position_vendor `samsara`, geofence visits)
 *   samsara / equipment_stats      /fleet/equipment/stats/feed, two calls of ≤ 4 types →
 *                                  engine hours (obdEngineSeconds where sent, else the synthetic
 *                                  or offset gateway counts, `adjusted` set), GPS odometer, fuel,
 *                                  engine state
 *
 * One batched `fleet`/`tick` per claimed positions run (also when the poll failed, so a Samsara
 * outage turns the RoGator stale like the trucks); `admin`/`sync.status` per step. The same
 * machine's Samsara AEMP snapshot (fleet.aemp, last-known) never replaces a fresh fix from here
 * (decision 1f-11). Unmapped equipment is skipped and logged once.
 */
import { getConfig } from '../config';
import { SamsaraEquipmentClient } from '../connectors/samsara/equipment-client';
import { mapEquipmentPosition, mapEquipmentStat } from '../connectors/samsara/equipment-mapper';
import type {
  SamsaraEquipmentPositionRaw,
  SamsaraEquipmentStatRaw,
} from '../connectors/samsara/equipment-schemas';
import { runSyncStep } from '../connectors/sync-step';
import type {
  NormalizedPosition,
  NormalizedVehicleStat,
  SyncStepResult,
  SyncStepSpec,
} from '../connectors/types';
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

export const EQUIPMENT_POSITIONS_STREAM = 'equipment_positions';
export const EQUIPMENT_STATS_STREAM = 'equipment_stats';
/** fleet.equipment has the default 45 s budget; its stream leases outlive it. */
export const EQUIPMENT_LEASE_SECONDS = 90;

export function createFleetEquipmentJob(opts: FleetJobOptions = {}) {
  return async function runFleetEquipment(ctx: JobContext): Promise<JobResult> {
    const cfg = (opts.config ?? getConfig)();
    const mode = cfg.CONNECTOR_SAMSARA;
    const http = httpFor(ctx, opts.http);
    const stale = staleThresholdsOf(cfg);
    const resolve = machineResolver();
    let client: SamsaraEquipmentClient | null = null;
    const samsara = () => {
      client ??= SamsaraEquipmentClient.forMode(mode, cfg, {
        http,
        onDropped: (feed, d) =>
          ctx.log.warn('samsara: an equipment row failed the schema and was dropped', {
            feed,
            index: d.index,
            id: d.id,
            reason: d.reason,
          }),
      });
      return client;
    };

    const posSpec: SyncStepSpec<SamsaraEquipmentPositionRaw, NormalizedPosition> = {
      source: 'samsara',
      stream: EQUIPMENT_POSITIONS_STREAM,
      mode,
      leaseSeconds: EQUIPMENT_LEASE_SECONDS,
      poll: (cursor) => samsara().pollPositions(cursor),
      map: (raw) => mapEquipmentPosition(raw),
      upsert: positionsUpsert(resolve, stale),
      afterRun: tickAfterRun(stale),
    };
    const positions = await runSyncStep(posSpec, ctx);
    const others: SyncStepResult[] = [];
    if (ctx.now().getTime() < ctx.deadline.getTime() && !ctx.signal.aborted) {
      const statsSpec: SyncStepSpec<SamsaraEquipmentStatRaw, NormalizedVehicleStat> = {
        source: 'samsara',
        stream: EQUIPMENT_STATS_STREAM,
        mode,
        leaseSeconds: EQUIPMENT_LEASE_SECONDS,
        poll: (cursor) => samsara().pollStats(cursor),
        map: (raw) => mapEquipmentStat(raw),
        upsert: statsUpsert(resolve),
        afterRun: publishSyncStatus,
      };
      others.push(await runSyncStep(statsSpec, ctx));
    }
    return combineStepResults(positions, others);
  };
}

export const runFleetEquipment = createFleetEquipmentJob();
