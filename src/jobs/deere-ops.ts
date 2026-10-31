/**
 * deere.ops (slice 1f; owner: the deere-ops builder, docs/contracts-1f.md §1, §5.1): every
 * 15 min (20 s demo cadence in sim/replay), per connected Deere org (decision 5): this crop
 * season's field operations with measurements, products and simplified coverage →
 * farm.operations, then `fields`/`updated` with part 'operations' per changed field.
 *
 * One sync step, stream `operations` (DEERE_OPERATIONS_STREAM):
 *   poll    src/connectors/deere/ops/poll.ts: orgs → fields → each field's operations of the
 *           crop year (America/Detroit), the fields checked longest ago first, at most the
 *           per-run cap under DEERE_DAILY_CALL_BUDGET (./deere-ops-budget.ts, sandbox/live only)
 *           and none started in the last PROCESS_RESERVE_MS of the job's budget; unchanged
 *           operations (same modifiedTime as stored) cost no more calls
 *   map     src/connectors/deere/ops/mapper.ts (pure)
 *   upsert  src/db/queries/operations.ts upsertOperation (clipping against the boundary valid
 *           at started_at, deterministic ids, nothing touched when nothing changed)
 *   afterRun  ages provisional operations into `final` (24 h unchanged), records the run's
 *           `fieldsPerRun` in sync_state.extra (calls per field for the cap), publishes
 *           `fields`/`updated` { parts: ['operations'] } once per changed field (one
 *           `fields`/`invalidate` above MAX_FIELD_MESSAGES), then `admin`/`sync.status`.
 *
 * Replay (CONNECTOR_DEERE=replay) runs the same client on the committed fixtures with no OAuth
 * (DeereClient.forReplay); sim talks to the stand-in's `ops` module.
 */
import type pg from 'pg';
import { type Config, getConfig } from '../config';
import { DEERE_OPERATIONS_STREAM } from '../connectors/deere/call-shares';
import { DeereClient } from '../connectors/deere/client';
import { mapDeereOperation } from '../connectors/deere/ops/mapper';
import { pollDeereOperations } from '../connectors/deere/ops/poll';
import type { DeereOperationRaw } from '../connectors/deere/ops/schemas';
import { type ConnectorConfig, deereEndpoints } from '../connectors/endpoints';
import type { VendorHttpOptions } from '../connectors/http';
import { tokenKey } from '../connectors/oauth/crypto';
import { OAuthTokenStore, userGrantOrg } from '../connectors/oauth/token-store';
import type { ReplayFixture } from '../connectors/replay';
import { runSyncStep } from '../connectors/sync-step';
import {
  type NormalizedOperation,
  type SyncStepSpec,
  syncStepJobResult,
} from '../connectors/types';
import { MAX_FIELD_MESSAGES } from '../db/queries/boundaries-sql';
import {
  finalizeOperations,
  recordFieldsPerRun,
  storedOperationModified,
  upsertOperation,
} from '../db/queries/operations';
import { readOpsBudget } from '../db/queries/operations-budget';
import { currentCropYear } from '../domain/crops';
import { publish } from '../platform/realtime/publish';
import { opsFieldCap } from './deere-ops-budget';
import { httpFor, publishSyncStatus } from './fleet-shared';
import type { JobContext, JobResult } from './types';

/** sync_state / api_calls_daily stream of deere.ops. */
export const DEERE_OPS_STREAM = DEERE_OPERATIONS_STREAM;
/** The end of the job's budget the poll leaves for processing what it landed. */
export const PROCESS_RESERVE_MS = 15_000;

/** What deere.ops reads from config (tests pass their own). */
export type DeereOpsConfig = ConnectorConfig &
  Pick<Config, 'CONNECTOR_DEERE'> &
  Partial<Pick<Config, 'DEERE_DAILY_CALL_BUDGET'>>;

export interface DeereOpsJobOptions {
  /** Default: getConfig() at run time. */
  config?: () => DeereOpsConfig;
  /** HTTP knobs for the client (tests: fetch, sleep, timeouts). */
  http?: Omit<VendorHttpOptions, 'vendor'>;
  /** Replay mode only: these fixtures instead of the committed Deere list (tests). */
  fixtures?: readonly ReplayFixture[];
}

/** `fields`/`updated` { parts: ['operations'] } per field, or one `fields`/`invalidate`. */
export async function publishOperationsChanged(
  pool: pg.Pool,
  fieldIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(fieldIds)].sort();
  if (!ids.length) return;
  if (ids.length > MAX_FIELD_MESSAGES) {
    await publish('fields', 'invalidate', { event: 'updated', reason: 'changed' }, pool);
    return;
  }
  for (const fieldId of ids) {
    await publish('fields', 'updated', { fieldId, parts: ['operations'] }, pool);
  }
}

export function createDeereOpsJob(opts: DeereOpsJobOptions = {}) {
  return async function runDeereOps(ctx: JobContext): Promise<JobResult> {
    const cfg = (opts.config ?? getConfig)();
    const mode = cfg.CONNECTOR_DEERE;
    const http = httpFor(ctx, opts.http);
    let client: DeereClient | null = null;
    let fieldsChecked: number | null = null;
    const changed = new Set<string>();

    const clientFor = (): DeereClient => {
      if (client) return client;
      if (mode === 'replay') {
        client = DeereClient.forReplay(cfg, http, opts.fixtures);
      } else {
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
      return client;
    };

    const spec: SyncStepSpec<DeereOperationRaw, NormalizedOperation> = {
      source: 'deere',
      stream: DEERE_OPS_STREAM,
      mode,
      poll: async (cursor) => {
        const fieldCap =
          mode === 'sandbox' || mode === 'live'
            ? opsFieldCap({
                budget: cfg.DEERE_DAILY_CALL_BUDGET,
                mode,
                ...(await readOpsBudget(ctx.pool, mode, ctx.now())),
              })
            : null;
        const r = await pollDeereOperations(cursor, {
          client: clientFor(),
          now: () => ctx.now(),
          stopAt: new Date(ctx.deadline.getTime() - PROCESS_RESERVE_MS),
          cropSeason: currentCropYear(ctx.now()),
          fieldCap,
          storedModified: (ids) => storedOperationModified(ctx.pool, 'deere', ids),
          log: ctx.log,
        });
        fieldsChecked = r.stats.fieldsChecked;
        ctx.log.info('deere.ops: polled', { ...r.stats, fieldCap });
        return r;
      },
      map: (raw) => mapDeereOperation(raw),
      upsert: async (tx, op) => {
        const r = await upsertOperation(tx, op, { now: ctx.now() });
        if (r.changed && r.fieldId) changed.add(r.fieldId);
      },
      afterRun: async (result, sctx) => {
        for (const f of await finalizeOperations(ctx.pool, 'deere', ctx.now())) changed.add(f);
        if (fieldsChecked !== null) {
          await recordFieldsPerRun(ctx.pool, 'deere', DEERE_OPS_STREAM, fieldsChecked);
        }
        await publishOperationsChanged(ctx.pool, [...changed]);
        await publishSyncStatus(result, sctx);
      },
    };
    return syncStepJobResult(await runSyncStep(spec, ctx));
  };
}

export const runDeereOps = createDeereOpsJob();
