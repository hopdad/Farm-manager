/**
 * deere.fields (slice 1f; owner: deere-data, docs/contracts-1f.md §1, §5.2, §5.4, §5.7, §9):
 * hourly (45 s demo cadence in sim/replay), per connected Deere org (decision 5), four sync
 * steps, each its own stream (lease, cursor, raw events, dead letters):
 *
 *   fields     farms, clients, fields and their active boundaries → farm.fields, the Deere
 *              boundary writer (decision 7), farms and customer parties (decision 8)
 *   flags      flags (archived ones too) → read-only farm.pins, one `pins`/`updated` per run
 *   equipment  the Equipment API → farm.machines for unmapped machines of the HOME org with a
 *              kind that maps; the rest counted in sync_state extra.unmappedKinds
 *   hours      engine hours of mapped machines → farm.machine_hours + machines.engine_hours
 *
 * Sim: the live client against the stand-in (fields module); replay: the same client on the
 * doc-derived fixtures (no OAuth); sandbox/live: Deere with the stored grant. Nothing is created
 * until a home org is known (`deereMayCreateRows`); rows that already map are still updated.
 * Every step's afterRun publishes `admin`/`sync.status` (the /admin/connectors page re-renders).
 */
import { type Config, getConfig } from '../config';
import { DeereClient } from '../connectors/deere/client';
import { DeereFieldsApi } from '../connectors/deere/fields/client';
import {
  type DeereFieldItem,
  type DeereMachineItem,
  mapDeereEngineHours,
  mapDeereEquipment,
  mapDeereField,
  mapDeereFlag,
} from '../connectors/deere/fields/mapper';
import {
  type DeereEngineHoursRaw,
  type DeereEquipmentRaw,
  type DeereFieldRaw,
  type DeereFlagsRaw,
  deereEquipmentRawSchema,
  deereFlagsRawSchema,
} from '../connectors/deere/fields/schemas';
import { DEERE_FIELDS_STREAMS, DeereFieldsRun } from '../connectors/deere/fields/sync';
import type { DeereHttpOptions } from '../connectors/deere/oauth';
import { type ConnectorConfig, deereEndpoints } from '../connectors/endpoints';
import { tokenKey } from '../connectors/oauth/crypto';
import { OAuthTokenStore, userGrantOrg } from '../connectors/oauth/token-store';
import type { ReplayFixture } from '../connectors/replay';
import { runSyncStep } from '../connectors/sync-step';
import {
  type NormalizedVehicleStat,
  type SyncContext,
  SyncStepError,
  type SyncStepResult,
  type SyncStepSpec,
  syncStepJobResult,
} from '../connectors/types';
import { resolveExternalRefs } from '../db/external-refs';
import {
  upsertDeereField,
  upsertDeereMachines,
  writeUnmappedKinds,
} from '../db/queries/deere-fields';
import { appendEngineHours } from '../db/queries/machine-hours';
import { applyDeereFlags, type OrgFlags } from '../db/queries/pins';
import { publish } from '../platform/realtime/publish';
import { httpFor, machineResolver, publishSyncStatus } from './fleet-shared';
import type { JobContext, JobResult } from './types';

/** What deere.fields reads from config (tests pass their own). */
export type DeereFieldsConfig = ConnectorConfig &
  Pick<Config, 'CONNECTOR_DEERE'> &
  Partial<Pick<Config, 'DEERE_HOME_ORG_ID'>>;

export interface DeereFieldsJobOptions {
  /** Default: getConfig() at run time. */
  config?: () => DeereFieldsConfig;
  /** HTTP knobs for the Deere client (tests: fetch, sleep, timeouts). */
  http?: Omit<DeereHttpOptions, 'vendor'>;
  /** Replay mode: these fixtures instead of the committed ones (tests). */
  replayFixtures?: readonly ReplayFixture[];
}

/** The equipment step's item: the normalized listing plus the run's home org. */
interface EquipmentItem {
  homeOrgId: string | null;
  machines: DeereMachineItem[];
}

/** One JobResult for the four steps: a failed step fails the job (after all of them ran). */
export function combineDeereFieldsResults(results: readonly SyncStepResult[]): JobResult {
  const failed = results.find((r) => r.claimed && !r.ok);
  if (failed) throw new SyncStepError(failed);
  const claimed = results.filter((r) => r.claimed);
  const first = results[0];
  if (claimed.length === 0 && first) return syncStepJobResult(first);
  const items = claimed.reduce((n, r) => n + r.processed, 0);
  const dead = claimed.reduce((n, r) => n + r.dead, 0);
  return dead > 0 ? { items, note: `${dead} dead-lettered` } : { items };
}

export function createDeereFieldsJob(opts: DeereFieldsJobOptions = {}) {
  return async function runDeereFields(ctx: JobContext): Promise<JobResult> {
    const cfg = (opts.config ?? getConfig)();
    const mode = cfg.CONNECTOR_DEERE;
    const http = httpFor(ctx, opts.http);
    let api: DeereFieldsApi | null = null;
    const deere = (): DeereFieldsApi => {
      if (api) return api;
      let client: DeereClient;
      if (mode === 'replay') {
        // Replay (contracts-m1 §10): the doc-derived fixtures, no OAuth.
        client = DeereClient.forReplay(cfg, http, opts.replayFixtures);
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
      api = new DeereFieldsApi(client);
      return api;
    };
    let run: DeereFieldsRun | null = null;
    const runOf = (): DeereFieldsRun => {
      run ??= new DeereFieldsRun({
        api: deere(),
        mode,
        homeOrgId: cfg.DEERE_HOME_ORG_ID ?? null,
        log: ctx.log,
        now: () => ctx.now(),
        mappedMachines: async (orgId, ids) =>
          new Set((await resolveExternalRefs(ctx.pool, 'deere', 'machine', orgId, ids)).keys()),
      });
      return run;
    };
    const status = (result: SyncStepResult, sctx: SyncContext) => publishSyncStatus(result, sctx);

    const fields: SyncStepSpec<DeereFieldRaw, DeereFieldItem> = {
      source: 'deere',
      stream: DEERE_FIELDS_STREAMS.fields,
      mode,
      poll: () => runOf().pollFields(),
      map: (raw) => mapDeereField(raw),
      upsert: async (tx, item) => {
        const r = await upsertDeereField(tx, item);
        if (r.action === 'skipped' && r.reason === 'no home org') {
          ctx.log.info('deere field not created: no home org (set DEERE_HOME_ORG_ID)', {
            orgId: item.field.sourceOrg,
            fieldId: item.field.externalId,
          });
        }
      },
      afterRun: status,
    };

    const flags: SyncStepSpec<DeereFlagsRaw, OrgFlags[]> = {
      source: 'deere',
      stream: DEERE_FIELDS_STREAMS.flags,
      mode,
      poll: () => runOf().pollFlags(),
      map: (raw) => {
        const r = deereFlagsRawSchema.parse(raw);
        return [
          r.orgs.map((o) => ({
            orgId: o.orgId,
            flags: o.flags.flatMap((f) => mapDeereFlag(o.orgId, f) ?? []),
          })),
        ];
      },
      upsert: async (tx, orgs) => {
        await applyDeereFlags(tx, orgs);
      },
      afterRun: status,
    };

    const equipment: SyncStepSpec<DeereEquipmentRaw, EquipmentItem> = {
      source: 'deere',
      stream: DEERE_FIELDS_STREAMS.equipment,
      mode,
      poll: () => runOf().pollEquipment(),
      map: (raw) => {
        const r = deereEquipmentRawSchema.parse(raw);
        return [
          {
            homeOrgId: r.homeOrgId,
            machines: r.orgs.flatMap((o) =>
              o.machines.flatMap((e) => mapDeereEquipment(o.orgId, e) ?? []),
            ),
          },
        ];
      },
      upsert: async (tx, item) => {
        const r = await upsertDeereMachines(tx, item.homeOrgId, item.machines);
        if (await writeUnmappedKinds(tx, r.unmappedKinds)) {
          ctx.log.info('deere equipment of kinds the app does not track (not created)', {
            unmappedKinds: r.unmappedKinds,
          });
        }
        if (r.created.length > 0) {
          ctx.log.info('deere machines created', { count: r.created.length });
          await publish('fleet', 'invalidate', { event: 'machine', reason: 'changed' }, tx);
        }
      },
      afterRun: status,
    };

    const resolve = machineResolver();
    let raised = 0;
    const hours: SyncStepSpec<DeereEngineHoursRaw, NormalizedVehicleStat> = {
      source: 'deere',
      stream: DEERE_FIELDS_STREAMS.hours,
      mode,
      poll: () => runOf().pollHours(),
      map: (raw) => mapDeereEngineHours(raw),
      upsert: async (tx, stat, sctx) => {
        if (stat.engineHours === undefined) return;
        const id = await resolve(tx, sctx, 'deere', stat.sourceOrg, stat.externalMachineId);
        if (!id) return;
        const r = await appendEngineHours(tx, id, { ts: stat.ts, engineHours: stat.engineHours });
        if (r.raised) raised++;
      },
      afterRun: async (result, sctx) => {
        // The fleet panel shows engine hours: one refetch when any meter moved this run.
        if (raised > 0) {
          await publish(
            'fleet',
            'invalidate',
            { event: 'machine', reason: 'changed' },
            sctx.job.pool,
          );
        }
        await status(result, sctx);
      },
    };

    const results: SyncStepResult[] = [];
    results.push(await runSyncStep(fields, ctx));
    results.push(await runSyncStep(flags, ctx));
    results.push(await runSyncStep(equipment, ctx));
    results.push(await runSyncStep(hours, ctx));
    return combineDeereFieldsResults(results);
  };
}

export const runDeereFields = createDeereFieldsJob();
