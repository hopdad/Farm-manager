/**
 * fleet.aemp (slice 1f.2; owner: the machines builder, docs/contracts-1f.md part B §B.4.8): the
 * generic ISO 15143-3 (AEMP 2.0) client (CONNECTOR_AEMP) over every configured provider
 * (AEMP_PROVIDERS; sim and replay: the stand-in's `kubota` and `samsara`).
 *
 *   aemp / fleet   Fleet pages → LAST-KNOWN positions (positionKind last_known, provider = the
 *                  AEMP provider: position_vendor `aemp_<provider>`; machine_state only, never
 *                  farm.positions, never a geofence visit) and stats (hours, odometer, fuel, DEF,
 *                  engine state, each dated by its own section), one stream for both; each
 *                  provider at most every `minIntervalSeconds` (the job runs every 15 min and
 *                  skips providers polled more recently: ../connectors/aemp/client.ts)
 *   aemp / faults  a provider's fault series (`faultsPath`) for the machines the app maps: each
 *                  FaultCode an occurrence → a `delta` fault that ages out (decision 1f-12)
 *
 * A last-known fix never replaces a fresh live one (decision 1f-11, `upsertPosition`'s
 * precedence with `staleThresholdsOf(cfg)`): the RoGator's Samsara AEMP snapshot waits while its
 * equipment feed (fleet.equipment) is fresh. Unmapped machines are skipped and logged once.
 * Providers that failed, and Deere's "approve the org" note, are kept in the stream's
 * sync_state.extra (`providers`, `providerErrors`) for /admin/connectors.
 */
import type pg from 'pg';
import { getConfig } from '../config';
import { AempClient, parseAempFaultsCursor, parseAempFleetCursor } from '../connectors/aemp/client';
import {
  type AempFaultRaw,
  type AempFleetItem,
  type AempFleetRaw,
  mapAempFault,
  mapAempFleet,
} from '../connectors/aemp/mapper';
import { refreshDeereTokens } from '../connectors/deere/oauth';
import {
  type AempEndpoint,
  aempEndpoints,
  deereEndpoints,
  replayFetch,
} from '../connectors/endpoints';
import { tokenKey } from '../connectors/oauth/crypto';
import { OAuthTokenStore, userGrantOrg } from '../connectors/oauth/token-store';
import { runSyncStep } from '../connectors/sync-step';
import type { Mode, SyncContext, SyncStepResult, SyncStepSpec } from '../connectors/types';
import { exec } from '../db/exec';
import { staleThresholdsOf } from '../db/queries/fleet';
import type { FaultCoverage } from '../db/queries/machine-faults';
import { combineStepResults, statsUpsert } from './fleet';
import {
  type FleetConfig,
  type FleetJobOptions,
  httpFor,
  machineResolver,
  positionsUpsert,
  publishSyncStatus,
  tickAfterRun,
  withFaultLifecycle,
} from './fleet-shared';
import type { JobContext, JobResult } from './types';

export const AEMP_FLEET_STREAM = 'fleet';
export const AEMP_FAULTS_STREAM = 'faults';
/** fleet.aemp has the default 45 s budget; its stream leases outlive it. */
export const AEMP_LEASE_SECONDS = 120;

/**
 * Merge `values` into the stream's ingest.sync_state.extra (writers merge their own keys and never
 * replace the object: docs/contracts-1f.md §3.1). Shared by the machines builder's jobs.
 */
export async function mergeStreamExtra(
  pool: pg.Pool,
  source: string,
  stream: string,
  values: Record<string, unknown>,
): Promise<void> {
  await exec(
    pool,
    `update ingest.sync_state
        set extra = coalesce(extra, '{}'::jsonb) || $3::jsonb
      where source = $1 and stream = $2`,
    [source, stream, JSON.stringify(values)],
  );
}

/** The machines the app maps per AEMP provider (the fault series is read for these only). */
async function mappedAempMachines(pool: pg.Pool): Promise<Record<string, string[]>> {
  const r = await exec<{ source_org: string; external_id: string }>(
    pool,
    `select source_org, external_id from ingest.external_refs
      where source = 'aemp' and kind = 'machine'
      order by source_org, external_id`,
  );
  const out: Record<string, string[]> = {};
  for (const row of r.rows) {
    const list = out[row.source_org] ?? [];
    list.push(row.external_id);
    out[row.source_org] = list;
  }
  return out;
}

/** What a faults run covered: each provider's machine through the end of its last window. */
export function aempFaultCoverage(cursor: string | null): FaultCoverage[] {
  const out: FaultCoverage[] = [];
  for (const [provider, p] of Object.entries(parseAempFaultsCursor(cursor).providers ?? {})) {
    for (const [externalId, done] of Object.entries(p?.machines ?? {})) {
      const t = Date.parse(done);
      if (Number.isFinite(t)) out.push({ sourceOrg: provider, externalId, through: new Date(t) });
    }
  }
  return out;
}

/** The providers to poll, or null when the mode can't poll (the step reports why). */
function endpointsOrNull(mode: Mode, cfg: FleetConfig): AempEndpoint[] | null {
  try {
    return aempEndpoints(mode, cfg);
  } catch {
    return null;
  }
}

export function createFleetAempJob(opts: FleetJobOptions = {}) {
  return async function runFleetAemp(ctx: JobContext): Promise<JobResult> {
    const cfg = (opts.config ?? getConfig)();
    const mode: Mode = cfg.CONNECTOR_AEMP ?? 'off';
    const http = httpFor(ctx, opts.http);
    const stale = staleThresholdsOf(cfg);
    const resolve = machineResolver();

    let client: AempClient | null = null;
    const aemp = () => {
      if (client) return client;
      const endpoints = aempEndpoints(mode, cfg);
      const needsDeere = endpoints.some((ep) => ep.auth === 'deere_oauth');
      const deereEp = needsDeere
        ? deereEndpoints(mode === 'sandbox' ? 'sandbox' : 'live', cfg)
        : null;
      client = new AempClient({
        endpoints,
        // Replay: the same client on the fixture transport (AempClient.forMode does the same).
        http: mode === 'replay' ? { ...http, fetch: replayFetch('aemp', { now: http.now }) } : http,
        deere: deereEp
          ? {
              store: new OAuthTokenStore({
                pool: ctx.pool,
                source: 'deere',
                org: userGrantOrg(deereEp),
                key: tokenKey(cfg.TOKEN_ENC_KEY),
              }),
              refresher: (rt) => refreshDeereTokens(deereEp, rt, http),
            }
          : null,
        onDropped: (provider, d) =>
          ctx.log.warn('aemp: an item failed the ISO 15143-3 schemas and was dropped', {
            provider,
            what: d.what,
            id: d.id,
            reason: d.reason,
          }),
      });
      return client;
    };
    const logFailed = (failed: { provider: string; error: string }[]) => {
      for (const f of failed) ctx.log.warn('aemp: a provider failed this poll', f);
    };

    const positions = positionsUpsert(resolve, stale);
    const stats = statsUpsert(resolve);
    const tick = tickAfterRun(stale);
    const fleetSpec: SyncStepSpec<AempFleetRaw, AempFleetItem> = {
      source: 'aemp',
      stream: AEMP_FLEET_STREAM,
      mode,
      leaseSeconds: AEMP_LEASE_SECONDS,
      poll: async (cursor) => {
        const r = await aemp().pollFleet(cursor);
        logFailed(r.failed);
        return r;
      },
      map: (raw) => mapAempFleet(raw),
      upsert: (tx, item, sctx) =>
        item.kind === 'position' ? positions(tx, item.position, sctx) : stats(tx, item.stat, sctx),
      afterRun: async (result: SyncStepResult, sctx: SyncContext) => {
        await tick(result, sctx);
        if (!result.cursor) return;
        const providers = parseAempFleetCursor(result.cursor).providers;
        const summary = Object.fromEntries(
          Object.entries(providers).map(([id, p]) => [
            id,
            { polledAt: p.polledAt ?? null, error: p.error ?? null, note: p.note ?? null },
          ]),
        );
        await mergeStreamExtra(sctx.job.pool, 'aemp', AEMP_FLEET_STREAM, {
          providers: summary,
          providerErrors: Object.values(providers).filter((p) => p.error).length,
        });
      },
    };
    const fleet = await runSyncStep(fleetSpec, ctx);

    const others: SyncStepResult[] = [];
    const hasSeries = mode !== 'off' && !!endpointsOrNull(mode, cfg)?.some((e) => e.faultsPath);
    if (ctx.now().getTime() < ctx.deadline.getTime() && !ctx.signal.aborted) {
      // No provider with a fault series in this mode = the faults stream is off: its mode change
      // closes the codes an earlier mode's series raised (nothing could close them later).
      const faultsSpec = withFaultLifecycle<AempFaultRaw>(
        {
          source: 'aemp',
          stream: AEMP_FAULTS_STREAM,
          mode: hasSeries ? mode : 'off',
          leaseSeconds: AEMP_LEASE_SECONDS,
          poll: async (cursor, sctx) => {
            const r = await aemp().pollFaults(cursor, await mappedAempMachines(sctx.job.pool));
            logFailed(r.failed);
            return r;
          },
          map: (raw) => mapAempFault(raw),
          upsert: stats,
          afterRun: publishSyncStatus,
        },
        // Each machine through the end of the window its series was last read to (a provider
        // that failed or wasn't due keeps its older time): occurrences carry no state, so a
        // fault that stops recurring ages out 24 h after its last one (decision 1f-12).
        (result) => aempFaultCoverage(result.cursor),
      );
      others.push(await runSyncStep(faultsSpec, ctx));
    }
    return combineStepResults(fleet, others);
  };
}

export const runFleetAemp = createFleetAempJob();
