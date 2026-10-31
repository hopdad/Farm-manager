/**
 * What the fleet.* jobs share (split out of ./fleet.ts for slice 1f, docs/contracts-1f.md §1:
 * fleet.trucks in ./fleet.ts belongs to the fleet-faults builder, fleet.deere in
 * ./fleet-deere.ts to sync-health). Config subset, HTTP knobs, the vendor-machine resolver, the
 * positions upsert (with geofence detection), and the afterRun hooks that publish ONE batched
 * `fleet`/`tick` plus `admin`/`sync.status` per claimed step. Owned by fleet-faults in 1f;
 * sync-health asks through its report.
 */
import type { Config } from '../config';
import type { ConnectorConfig } from '../connectors/endpoints';
import type { VendorHttpOptions } from '../connectors/http';
import {
  type ConnectorSource,
  externalRefKey,
  type NormalizedPosition,
  type SyncContext,
  type SyncStepResult,
} from '../connectors/types';
import { type Executor, exec, toDate } from '../db/exec';
import { resolveExternalRefs } from '../db/external-refs';
import { fleetSnapshot, upsertPosition } from '../db/queries/fleet';
import type { StaleThresholds } from '../domain/fleet';
import { publish } from '../platform/realtime/publish';
import { detectGeofenceVisits } from './geofences';
import type { JobContext } from './types';

/**
 * What the fleet jobs read from config (tests pass their own). 1f.2: one mode key per telematics
 * connection (CONNECTOR_SAMSARA, CONNECTOR_MOTIVE, …); the deprecated CONNECTOR_ELD alias is
 * resolved by src/config.ts and never read here.
 */
export type FleetConfig = ConnectorConfig &
  Pick<
    Config,
    | 'CONNECTOR_DEERE'
    | 'CONNECTOR_SAMSARA'
    | 'CONNECTOR_MOTIVE'
    | 'FLEET_STALE_SECONDS'
    | 'FLEET_STALE_SECONDS_DEERE'
    | 'DEERE_DAILY_CALL_BUDGET'
  > &
  Partial<
    Pick<
      Config,
      | 'CONNECTOR_GEOTAB'
      | 'CONNECTOR_AEMP'
      | 'CONNECTOR_CNH'
      | 'CONNECTOR_TERMINAL'
      | 'FLEET_STALE_SECONDS_LAST_KNOWN'
      | 'VEHICLE_KIND_TAGS'
    >
  >;

export interface FleetJobOptions {
  /** Default: getConfig() at run time. */
  config?: () => FleetConfig;
  /** HTTP knobs for the vendor clients (tests: fetch, sleep, timeouts). */
  http?: Omit<VendorHttpOptions, 'vendor'>;
}

export function httpFor(
  ctx: JobContext,
  extra: FleetJobOptions['http'],
): Omit<VendorHttpOptions, 'vendor'> {
  return { signal: ctx.signal, deadline: ctx.deadline, now: () => ctx.now(), ...extra };
}

/**
 * vendor machine id → farm.machines.id, cached per run (null = unmapped, logged once).
 * `orgFallback` (1f.2, Motive and Geotab): when the item's sourceOrg (the Motive company id)
 * has no ref, try the org-less ref ('' source_org) a database seeded before the hauler's ref
 * moved under its company still has (until `pnpm db:seed demo`).
 */
export function machineResolver(opts: { orgFallback?: boolean } = {}) {
  const cache = new Map<string, string | null>();
  return async (
    ex: Executor,
    ctx: SyncContext,
    source: ConnectorSource,
    sourceOrg: string,
    externalId: string,
  ): Promise<string | null> => {
    const key = externalRefKey(source, 'machine', externalId, sourceOrg);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let found = await resolveExternalRefs(ex, source, 'machine', sourceOrg, [externalId]);
    if (!found.get(externalId) && opts.orgFallback && sourceOrg !== '') {
      found = await resolveExternalRefs(ex, source, 'machine', '', [externalId]);
    }
    const id = found.get(externalId) ?? null;
    cache.set(key, id);
    if (!id) {
      ctx.job.log.info('unmapped vendor machine (no ingest.external_refs row); skipped', {
        source,
        sourceOrg,
        externalId,
      });
    }
    return id;
  };
}

export async function publishSyncStatus(result: SyncStepResult, sctx: SyncContext): Promise<void> {
  const r = await exec<{ last_ok_at: Date | string | null; last_error: string | null }>(
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

/** afterRun of a positions step: ONE batched fleet.tick (+ sync.status). */
export function tickAfterRun(stale: StaleThresholds) {
  return async (result: SyncStepResult, sctx: SyncContext): Promise<void> => {
    const tick = await fleetSnapshot(sctx.job.pool, sctx.job.now(), stale);
    await publish('fleet', 'tick', tick, sctx.job.pool);
    await publishSyncStatus(result, sctx);
  };
}

/**
 * One fix: farm.positions + machine_state, then geofence enter/exit for a NEW fix in the same
 * per-event transaction (src/jobs/geofences.ts), so a fix and its visits commit together.
 * `stale` (staleThresholdsOf(cfg)) decides when a last-known snapshot may replace a live fix
 * (upsertPosition's precedence; jobs that write `last_known` fixes pass it).
 */
export function positionsUpsert(
  resolve: ReturnType<typeof machineResolver>,
  stale?: StaleThresholds,
) {
  return async (tx: Executor, p: NormalizedPosition, sctx: SyncContext): Promise<void> => {
    const id = await resolve(tx, sctx, p.source, p.sourceOrg, p.externalMachineId);
    if (!id) return;
    const stored = await upsertPosition(tx, id, p, stale);
    if (stored.inserted) await detectGeofenceVisits(tx, id, p.ts);
  };
}
