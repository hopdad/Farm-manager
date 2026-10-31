/**
 * fleet.cnh (slice 1f.2; owner: the machines builder, docs/contracts-1f.md part B §B.4.8): CNH
 * FieldOps (CONNECTOR_CNH; sim = its own stand-in at /cnh, sandbox = staging, live = production;
 * no replay: config refuses it) for the Case IH machines, by VIN, in their CNH company:
 *
 *   cnh / positions  the Locations series → LIVE fixes (farm.positions + machine_state,
 *                    position_vendor `cnh`)
 *   cnh / fleet      the Fleet snapshot, at most hourly → stats (hours, odometer, fuel, DEF, engine)
 *                    and its Location as a LAST-KNOWN fix (a machine whose Locations are empty
 *                    still shows where the snapshot last saw it; a fresh live fix always wins)
 *   cnh / faults     CautionCodes (Active → open/closed) and Faults (occurrences that age out),
 *                    both `delta`
 *
 * OAuth tokens: ingest.oauth_tokens, source `cnh` (one user-level grant; sim's in its own row).
 * In sim the grant is created unattended; in sandbox/live a missing grant fails the step with
 * "sign in at /api/oauth/cnh". A VIN without an accepted EULA is skipped and listed once (log),
 * and every stream keeps the list in its sync_state.extra (`needsEula`, `needsEulaCount`).
 */
import { getConfig } from '../config';
import type { AempFleetItem } from '../connectors/aemp/mapper';
import { CnhClient } from '../connectors/cnh/client';
import {
  type CnhFaultRaw,
  type CnhFleetRaw,
  type CnhPositionRaw,
  mapCnhFault,
  mapCnhFleet,
  mapCnhPosition,
} from '../connectors/cnh/mapper';
import { cnhGrantOrg } from '../connectors/cnh/oauth';
import {
  type CnhNeedsEula,
  type CnhPollResult,
  pollCnhFaults,
  pollCnhFleet,
  pollCnhPositions,
} from '../connectors/cnh/sync';
import { cnhEndpoints } from '../connectors/endpoints';
import { tokenKey } from '../connectors/oauth/crypto';
import { OAuthTokenStore } from '../connectors/oauth/token-store';
import { runSyncStep } from '../connectors/sync-step';
import type {
  Mode,
  NormalizedPosition,
  NormalizedVehicleStat,
  SyncContext,
  SyncStepResult,
  SyncStepSpec,
} from '../connectors/types';
import { staleThresholdsOf } from '../db/queries/fleet';
import { combineStepResults, statsUpsert } from './fleet';
import { mergeStreamExtra } from './fleet-aemp';
import {
  type FleetJobOptions,
  httpFor,
  machineResolver,
  positionsUpsert,
  publishSyncStatus,
  tickAfterRun,
} from './fleet-shared';
import type { JobContext, JobResult } from './types';

export const CNH_POSITIONS_STREAM = 'positions';
export const CNH_FLEET_STREAM = 'fleet';
export const CNH_FAULTS_STREAM = 'faults';
/** fleet.cnh has the default 45 s budget; its stream leases outlive it. */
export const CNH_LEASE_SECONDS = 120;

/** The `needsEula` list a stream's cursor holds, for sync_state.extra. */
function needsEulaOf(cursor: string | null): { vin: string; reason: string; at: string }[] {
  if (!cursor?.startsWith('{')) return [];
  try {
    const n = (JSON.parse(cursor) as { needsEula?: Record<string, CnhNeedsEula> }).needsEula ?? {};
    return Object.entries(n).map(([vin, e]) => ({ vin, reason: e.reason, at: e.at }));
  } catch {
    return [];
  }
}

export function createFleetCnhJob(opts: FleetJobOptions = {}) {
  return async function runFleetCnh(ctx: JobContext): Promise<JobResult> {
    const cfg = (opts.config ?? getConfig)();
    const mode: Mode = cfg.CONNECTOR_CNH ?? 'off';
    const http = httpFor(ctx, opts.http);
    const stale = staleThresholdsOf(cfg);
    const resolve = machineResolver();
    const pollOpts = { now: () => ctx.now(), deadline: ctx.deadline };

    let client: CnhClient | null = null;
    const cnh = () => {
      if (client) return client;
      const ep = cnhEndpoints(mode, cfg);
      client = new CnhClient({
        endpoints: ep,
        tokens: new OAuthTokenStore({
          pool: ctx.pool,
          source: 'cnh',
          org: cnhGrantOrg(ep),
          key: tokenKey(cfg.TOKEN_ENC_KEY),
        }),
        http,
      });
      return client;
    };
    const report = <T>(stream: string, r: CnhPollResult<T>) => {
      for (const vin of r.newlyNeedsEula) {
        ctx.log.warn(
          'cnh: a VIN has no accepted EULA; its telemetry is skipped (accept it in FieldOps)',
          {
            stream,
            vin,
          },
        );
      }
      for (const s of r.skipped) ctx.log.info('cnh: a machine was skipped', { stream, ...s });
      return r;
    };
    const withEula =
      (stream: string, after: (r: SyncStepResult, s: SyncContext) => Promise<void>) =>
      async (result: SyncStepResult, sctx: SyncContext) => {
        await after(result, sctx);
        if (!result.cursor) return;
        const needsEula = needsEulaOf(result.cursor);
        await mergeStreamExtra(sctx.job.pool, 'cnh', stream, {
          needsEula,
          needsEulaCount: needsEula.length,
        });
      };

    const tick = tickAfterRun(stale);
    const positions = positionsUpsert(resolve, stale);
    const stats = statsUpsert(resolve);

    const posSpec: SyncStepSpec<CnhPositionRaw, NormalizedPosition> = {
      source: 'cnh',
      stream: CNH_POSITIONS_STREAM,
      mode,
      leaseSeconds: CNH_LEASE_SECONDS,
      poll: async (cursor) =>
        report(CNH_POSITIONS_STREAM, await pollCnhPositions(cnh(), cursor, pollOpts)),
      map: (raw) => mapCnhPosition(raw),
      upsert: positions,
      afterRun: withEula(CNH_POSITIONS_STREAM, tick),
    };
    const first = await runSyncStep(posSpec, ctx);
    const others: SyncStepResult[] = [];
    const more = () => ctx.now().getTime() < ctx.deadline.getTime() && !ctx.signal.aborted;

    if (more()) {
      const fleetSpec: SyncStepSpec<CnhFleetRaw, AempFleetItem> = {
        source: 'cnh',
        stream: CNH_FLEET_STREAM,
        mode,
        leaseSeconds: CNH_LEASE_SECONDS,
        // "At most hourly" is the poll's own pacing (its cursor keeps the last successful poll).
        poll: async (cursor) =>
          report(CNH_FLEET_STREAM, await pollCnhFleet(cnh(), cursor, pollOpts)),
        map: (raw) => mapCnhFleet(raw),
        upsert: (tx, item, sctx) =>
          item.kind === 'position'
            ? positions(tx, item.position, sctx)
            : stats(tx, item.stat, sctx),
        afterRun: withEula(CNH_FLEET_STREAM, tick),
      };
      others.push(await runSyncStep(fleetSpec, ctx));
    }
    if (more()) {
      const faultsSpec: SyncStepSpec<CnhFaultRaw, NormalizedVehicleStat> = {
        source: 'cnh',
        stream: CNH_FAULTS_STREAM,
        mode,
        leaseSeconds: CNH_LEASE_SECONDS,
        poll: async (cursor) =>
          report(CNH_FAULTS_STREAM, await pollCnhFaults(cnh(), cursor, pollOpts)),
        map: (raw) => mapCnhFault(raw),
        upsert: stats,
        afterRun: withEula(CNH_FAULTS_STREAM, publishSyncStatus),
      };
      others.push(await runSyncStep(faultsSpec, ctx));
    }
    return combineStepResults(first, others);
  };
}

export const runFleetCnh = createFleetCnhJob();
