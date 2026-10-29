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
 */
import { type Config, getConfig } from '../config';
import { DeereClient } from '../connectors/deere/client';
import { mapDeereBreadcrumb } from '../connectors/deere/mapper';
import type { DeereBreadcrumbRaw } from '../connectors/deere/schemas';
import { type ConnectorConfig, deereEndpoints } from '../connectors/endpoints';
import type { VendorHttpOptions } from '../connectors/http';
import { MotiveClient, mapMotivePosition } from '../connectors/motive/client';
import type { MotivePositionRaw } from '../connectors/motive/schemas';
import { tokenKey } from '../connectors/oauth/crypto';
import { OAuthTokenStore, userGrantOrg } from '../connectors/oauth/token-store';
import { SamsaraClient } from '../connectors/samsara/client';
import { mapSamsaraPosition, mapSamsaraStat } from '../connectors/samsara/mapper';
import type { SamsaraPositionRaw, SamsaraStatRaw } from '../connectors/samsara/schemas';
import { runSyncStep } from '../connectors/sync-step';
import {
  type ConnectorSource,
  externalRefKey,
  type NormalizedPosition,
  type NormalizedVehicleStat,
  type SyncContext,
  SyncStepError,
  type SyncStepResult,
  type SyncStepSpec,
  syncStepJobResult,
} from '../connectors/types';
import { type Executor, exec, toDate } from '../db/exec';
import { resolveExternalRefs } from '../db/external-refs';
import {
  fleetSnapshot,
  staleThresholdsOf,
  upsertPosition,
  upsertVehicleStat,
} from '../db/queries/fleet';
import type { StaleThresholds } from '../domain/fleet';
import { publish } from '../platform/realtime/publish';
import { detectGeofenceVisits } from './geofences';
import type { JobContext, JobResult } from './types';

/** What the fleet jobs read from config (tests pass their own). */
export type FleetConfig = ConnectorConfig &
  Pick<
    Config,
    | 'CONNECTOR_ELD'
    | 'CONNECTOR_DEERE'
    | 'ELD_VENDOR'
    | 'FLEET_STALE_SECONDS'
    | 'FLEET_STALE_SECONDS_DEERE'
  >;

export interface FleetJobOptions {
  /** Default: getConfig() at run time. */
  config?: () => FleetConfig;
  /** HTTP knobs for the vendor clients (tests: fetch, sleep, timeouts). */
  http?: Omit<VendorHttpOptions, 'vendor'>;
}

export const TRUCKS_STREAM = 'positions';
export const STATS_STREAM = 'stats';
export const DEERE_STREAM = 'locations';
/** fleet.trucks runs every 30 s with a 25 s budget; its stream lease must outlive the budget. */
export const TRUCKS_BUDGET_MS = 25_000;
export const TRUCKS_LEASE_SECONDS = 60;

function httpFor(
  ctx: JobContext,
  extra: FleetJobOptions['http'],
): Omit<VendorHttpOptions, 'vendor'> {
  return { signal: ctx.signal, deadline: ctx.deadline, now: () => ctx.now(), ...extra };
}

/** vendor machine id → farm.machines.id, cached per run (null = unmapped, logged once). */
function machineResolver() {
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
    const found = await resolveExternalRefs(ex, source, 'machine', sourceOrg, [externalId]);
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

async function publishSyncStatus(result: SyncStepResult, sctx: SyncContext): Promise<void> {
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
function tickAfterRun(stale: StaleThresholds) {
  return async (result: SyncStepResult, sctx: SyncContext): Promise<void> => {
    const tick = await fleetSnapshot(sctx.job.pool, sctx.job.now(), stale);
    await publish('fleet', 'tick', tick, sctx.job.pool);
    await publishSyncStatus(result, sctx);
  };
}

/**
 * One fix: farm.positions + machine_state, then geofence enter/exit for a NEW fix in the same
 * per-event transaction (src/jobs/geofences.ts), so a fix and its visits commit together.
 */
function positionsUpsert(resolve: ReturnType<typeof machineResolver>) {
  return async (tx: Executor, p: NormalizedPosition, sctx: SyncContext): Promise<void> => {
    const id = await resolve(tx, sctx, p.source, p.sourceOrg, p.externalMachineId);
    if (!id) return;
    const stored = await upsertPosition(tx, id, p);
    if (stored.inserted) await detectGeofenceVisits(tx, id, p.ts);
  };
}

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

export function createFleetDeereJob(opts: FleetJobOptions = {}) {
  return async function runFleetDeere(ctx: JobContext): Promise<JobResult> {
    const cfg = (opts.config ?? getConfig)();
    const mode = cfg.CONNECTOR_DEERE;
    const http = httpFor(ctx, opts.http);
    const resolve = machineResolver();
    let client: DeereClient | null = null;
    const spec: SyncStepSpec<DeereBreadcrumbRaw, NormalizedPosition> = {
      source: 'deere',
      stream: DEERE_STREAM,
      mode,
      poll: (cursor) => {
        if (!client && mode === 'replay') {
          // Replay (contracts-m1 §10): the doc-derived fixtures, no OAuth.
          client = DeereClient.forReplay(cfg, http);
        }
        if (!client) {
          const endpoints = deereEndpoints(mode, cfg);
          client = new DeereClient({
            endpoints,
            tokens: new OAuthTokenStore({
              pool: ctx.pool,
              source: 'deere',
              org: userGrantOrg(endpoints),
              key: tokenKey(cfg.TOKEN_ENC_KEY),
              now: () => ctx.now(),
            }),
            http,
          });
        }
        return client.pollLocations(cursor);
      },
      map: (raw) => mapDeereBreadcrumb(raw),
      upsert: positionsUpsert(resolve),
      afterRun: tickAfterRun(staleThresholdsOf(cfg)),
    };
    return syncStepJobResult(await runSyncStep(spec, ctx));
  };
}

export const runFleetTrucks = createFleetTrucksJob();
export const runFleetDeere = createFleetDeereJob();
