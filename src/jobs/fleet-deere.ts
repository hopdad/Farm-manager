/**
 * fleet.deere: Deere breadcrumbs (working machines only) → farm.positions + machine_state, then
 * ONE batched `fleet`/`tick` (plan §5 per-source table, contracts §5/§7/§8). Replay mode runs the
 * same client on the doc-derived fixtures with no OAuth (DeereClient.forReplay).
 *
 * Split out of ./fleet.ts for slice 1f (docs/contracts-1f.md §1): owned by the sync-health
 * builder (decision 4 pacing from the call budget, decision 5 org approval for locations). The
 * shared pieces live in ./fleet-shared.ts.
 */
import { getConfig } from '../config';
import { DeereClient } from '../connectors/deere/client';
import { mapDeereBreadcrumb } from '../connectors/deere/mapper';
import type { DeereBreadcrumbRaw } from '../connectors/deere/schemas';
import { deereEndpoints } from '../connectors/endpoints';
import { tokenKey } from '../connectors/oauth/crypto';
import { OAuthTokenStore, userGrantOrg } from '../connectors/oauth/token-store';
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

export const DEERE_STREAM = 'locations';

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

export const runFleetDeere = createFleetDeereJob();
