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
  type NormalizedVehicleStat,
  type SyncContext,
  type SyncStepResult,
  type SyncStepSpec,
} from '../connectors/types';
import { type Executor, exec, toDate } from '../db/exec';
import { resolveExternalRefs } from '../db/external-refs';
import { fleetSnapshot, upsertPosition } from '../db/queries/fleet';
import { ageOutFaults, closeSourceFaults, type FaultCoverage } from '../db/queries/machine-faults';
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

/**
 * What a faults run checked, for the age-out sweep: the run's first poll time, and whether its
 * last poll said the vendor had nothing more (a feed with a backlog left isn't caught up).
 */
export interface FaultsRunTrack {
  startedAt: Date | null;
  caughtUp: boolean;
}

/**
 * A faults stream with the fault lifecycle around it (decision 1f-12, docs/contracts-1f.md §5.3):
 *  - a mode change (sim → live, replay → sim, → off) closes the source's open codes
 *    (`closeSourceFaults`);
 *  - after a successful run that caught up and left no raw event pending, the age-out sweep
 *    (`ageOutFaults`) closes the codes whose window ran out before the time the run checked their
 *    machine through. `coverage` says what the run covered (default: every machine of the source,
 *    through the run's first poll); return [] when it covered nothing.
 * Every faults spec goes through this, so no source can leave a code open for ever.
 */
export function withFaultLifecycle<TRaw>(
  spec: SyncStepSpec<TRaw, NormalizedVehicleStat>,
  coverage?: (result: SyncStepResult, track: FaultsRunTrack) => FaultCoverage[],
): SyncStepSpec<TRaw, NormalizedVehicleStat> {
  const track: FaultsRunTrack = { startedAt: null, caughtUp: false };
  return {
    ...spec,
    poll: async (cursor, sctx) => {
      track.startedAt ??= sctx.job.now();
      track.caughtUp = false;
      const r = await spec.poll(cursor, sctx);
      track.caughtUp = !r.hasMore;
      return r;
    },
    onModeChange: async (change, sctx) => {
      const r = await sctx.job.db.transaction((tx) => closeSourceFaults(tx, spec.source));
      sctx.job.log.info('faults: mode changed; the open codes of the source were closed', {
        source: spec.source,
        from: change.from,
        to: change.to,
        cleared: r.cleared,
      });
    },
    afterRun: async (result, sctx) => {
      if (spec.afterRun) await spec.afterRun(result, sctx);
      if (!result.ok || !track.caughtUp || !track.startedAt) return;
      const pending = await exec(
        sctx.job.pool,
        `select 1 from ingest.raw_events
          where source = $1 and stream = $2 and status = 'pending' limit 1`,
        [spec.source, spec.stream],
      );
      if (pending.rowCount) return; // the next run sweeps once they are applied
      const cov = coverage
        ? coverage(result, track)
        : [{ through: track.startedAt } satisfies FaultCoverage];
      if (!cov.length) return;
      const r = await sctx.job.db.transaction((tx) => ageOutFaults(tx, spec.source, cov));
      if (r.cleared) {
        sctx.job.log.info('faults: aged out (not seen within their window)', {
          source: spec.source,
          cleared: r.cleared,
        });
      }
    },
  };
}
