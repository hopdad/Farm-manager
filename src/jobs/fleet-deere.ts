/**
 * fleet.deere: Deere breadcrumbs (working machines only) → farm.positions + machine_state, then
 * ONE batched `fleet`/`tick` (plan §5 per-source table, contracts §5/§7/§8). Replay mode runs the
 * same client on the doc-derived fixtures with no OAuth (DeereClient.forReplay).
 *
 * Split out of ./fleet.ts for slice 1f (docs/contracts-1f.md §1): owned by the sync-health
 * builder. The shared pieces live in ./fleet-shared.ts. 1f adds:
 *
 *  - Decision 4, the call budget: with DEERE_DAILY_CALL_BUDGET set and the Deere mode sandbox or
 *    live, the `locations` stream is paced with the shared split (src/connectors/call-budget.ts
 *    `loadFleetDeerePace` → `SyncStepSpec.minIntervalSeconds`: share = locationsShare(B, the last
 *    full UTC day's other Deere streams), interval = paceSeconds(callsPerRun, share)); never
 *    faster than its cron. Unset budget, sim/replay or nothing measured = the cron alone.
 *  - Decision 5, org approval: the poll isolates orgs (DeereClient.pollLocationsWithOrgs): a
 *    needs-approval org is skipped and logged, a 403 mid-run stops only that org, the others'
 *    machines keep flowing. afterRun writes what the run saw to ingest.connector_orgs (with the
 *    connector mode; rows the listing no longer has are deleted).
 *  - Decision 8, the home org: after each listing, `deereHomeOrg(mode, DEERE_HOME_ORG_ID, orgs)`
 *    is kept in this stream's sync_state.extra.homeOrg (merged) for /admin/connectors.
 */
import { type Config, getConfig } from '../config';
import { loadFleetDeerePace } from '../connectors/call-budget';
import { DeereClient, type DeereLocationsPoll } from '../connectors/deere/client';
import { mapDeereBreadcrumb } from '../connectors/deere/mapper';
import { deereHomeOrg } from '../connectors/deere/orgs';
import type { DeereBreadcrumbRaw } from '../connectors/deere/schemas';
import { deereEndpoints } from '../connectors/endpoints';
import { tokenKey } from '../connectors/oauth/crypto';
import { OAuthTokenStore, userGrantOrg } from '../connectors/oauth/token-store';
import { errorText, runSyncStep } from '../connectors/sync-step';
import {
  type NormalizedPosition,
  type SyncContext,
  type SyncStepResult,
  type SyncStepSpec,
  syncStepJobResult,
} from '../connectors/types';
import { isCountedMode } from '../db/queries/api-calls';
import {
  mergeSyncStateExtra,
  type StoredHomeOrg,
  saveConnectorOrgs,
} from '../db/queries/connector-orgs';
import { staleThresholdsOf } from '../db/queries/fleet';
import {
  type FleetConfig,
  type FleetJobOptions,
  httpFor,
  machineResolver,
  positionsUpsert,
  tickAfterRun,
} from './fleet-shared';
import type { JobContext, JobResult } from './types';

export const DEERE_STREAM = 'locations';

/** What fleet.deere reads from config: FleetConfig plus the home org (decision 8). */
export type FleetDeereConfig = FleetConfig & Partial<Pick<Config, 'DEERE_HOME_ORG_ID'>>;

export interface FleetDeereJobOptions extends FleetJobOptions {
  config?: () => FleetDeereConfig;
}

export function createFleetDeereJob(opts: FleetDeereJobOptions = {}) {
  return async function runFleetDeere(ctx: JobContext): Promise<JobResult> {
    const cfg = (opts.config ?? getConfig)() as FleetDeereConfig;
    const mode = cfg.CONNECTOR_DEERE;
    const http = httpFor(ctx, opts.http);
    const resolve = machineResolver();
    const tick = tickAfterRun(staleThresholdsOf(cfg));
    let client: DeereClient | null = null;
    let seen: DeereLocationsPoll | null = null;

    // Decision 4: the pace from the budget (sandbox/live only; null = the cron alone).
    let minIntervalSeconds: number | null = null;
    if (isCountedMode(mode)) {
      const pace = await loadFleetDeerePace(ctx.pool, {
        budget: cfg.DEERE_DAILY_CALL_BUDGET,
        mode,
        now: ctx.now(),
      });
      minIntervalSeconds = pace.minIntervalSeconds;
      if (pace.paced) ctx.log.info('fleet.deere paced by the call budget', { reason: pace.reason });
    }

    const afterRun = async (result: SyncStepResult, sctx: SyncContext): Promise<void> => {
      await tick(result, sctx);
      if (!seen || !isCountedMode(mode)) return;
      const run = seen;
      try {
        await saveConnectorOrgs(ctx.pool, 'deere', mode, run.orgs, { listed: true });
        const home = deereHomeOrg(mode, cfg.DEERE_HOME_ORG_ID, run.listing);
        const homeOrg: StoredHomeOrg = {
          orgId: home.orgId,
          source: home.source,
          mode,
          candidates: run.listing.map((o) => ({
            id: o.id,
            name: o.name,
            member: o.member ?? null,
          })),
          at: ctx.now().toISOString(),
        };
        await mergeSyncStateExtra(ctx.pool, 'deere', DEERE_STREAM, { homeOrg });
      } catch (e) {
        // The locations themselves synced; the org status shows again after the next run.
        ctx.log.warn('deere org status not saved', { error: errorText(e) });
      }
    };

    const spec: SyncStepSpec<DeereBreadcrumbRaw, NormalizedPosition> = {
      source: 'deere',
      stream: DEERE_STREAM,
      mode,
      minIntervalSeconds,
      poll: async (cursor) => {
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
        const r = await client.pollLocationsWithOrgs(cursor);
        seen = r;
        for (const o of r.orgs) {
          if (o.status !== 'needs_approval') continue;
          ctx.log.info('deere org skipped: needs approval', {
            orgId: o.orgId,
            detail: o.detail,
          });
        }
        return { items: r.items, cursor: r.cursor, hasMore: r.hasMore };
      },
      map: (raw) => mapDeereBreadcrumb(raw),
      upsert: positionsUpsert(resolve),
      afterRun,
    };
    return syncStepJobResult(await runSyncStep(spec, ctx));
  };
}

export const runFleetDeere = createFleetDeereJob();
