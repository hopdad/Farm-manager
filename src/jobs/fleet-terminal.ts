/**
 * fleet.terminal (slice 1f.2; the terminal-pickups builder, docs/contracts-1f.md part B §B.4.8):
 * Terminal (CONNECTOR_TERMINAL), the aggregator for hired trucks on the long tail of ELDs,
 * through the vehicle telematics port, one stream per port method (every 60 s, 15 s demo,
 * within the job budget):
 *
 *   positions  per vehicle: Terminal's history breadcrumbs (`live`: farm.positions + machine_state,
 *              geofences) then the provider's latest location (`last_known`: machine_state only,
 *              and never over a fresh live fix: the §5.0 precedence, so the badge stays live
 *              while history is fresh); vendor id `terminal_<provider>`; ONE batched
 *              `fleet`/`tick`
 *   stats      stat logs (engine runtime → hours, odometer km → miles, fuel %, engine state) and
 *              the latest location's counters → machines (never decreasing) + machine_state
 *   faults     fault code events as `delta` reports with the 24 h age-out (fleet-faults' writer
 *              stores them; some providers never send `closed`)
 *   vehicles   group names → kind (VEHICLE_KIND_TAGS; an admin-set kind wins), at most hourly
 *   providers  GET /providers → the capability rows of the providers behind our connections,
 *              in ingest.sync_state (terminal, providers) extra.providers (merged), at most hourly
 *
 * Vehicles map through ingest.external_refs ('terminal', 'machine', <vcl id>, <connection id>);
 * only mapped vehicles are asked for and landed (never created). Positions first (they feed the
 * tick); the other streams only while budget remains.
 */
import { getConfig } from '../config';
import { runSyncStep } from '../connectors/sync-step';
import { TerminalClient } from '../connectors/terminal/client';
import {
  mapTerminalFault,
  mapTerminalPosition,
  mapTerminalProviders,
  mapTerminalStat,
  mapTerminalVehicle,
} from '../connectors/terminal/mapper';
import type {
  TerminalFaultRaw,
  TerminalPositionRaw,
  TerminalProvidersRaw,
  TerminalStatRaw,
  TerminalVehicleRaw,
} from '../connectors/terminal/schemas';
import type {
  NormalizedPosition,
  NormalizedVehicle,
  NormalizedVehicleStat,
  SyncStepResult,
  SyncStepSpec,
} from '../connectors/types';
import { mappedVehicleRefs, vehicleListUpsert } from '../connectors/vehicles/refs';
import type { TerminalProviderRow } from '../connectors/vendors';
import { type Executor, exec } from '../db/exec';
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

export const TERMINAL_POSITIONS_STREAM = 'positions';
export const TERMINAL_STATS_STREAM = 'stats';
export const TERMINAL_FAULTS_STREAM = 'faults';
export const TERMINAL_VEHICLES_STREAM = 'vehicles';
export const TERMINAL_PROVIDERS_STREAM = 'providers';
/** fleet.terminal's stream lease must outlive the job budget (45 s default). */
export const TERMINAL_LEASE_SECONDS = 90;
/** The vehicle list and the provider catalog change rarely: at most hourly. */
export const TERMINAL_SLOW_STREAM_MIN_INTERVAL_SECONDS = 3_600;

/**
 * The provider rows in ingest.sync_state (terminal, providers) `extra.providers`, merged into
 * the object (other keys such as sync-health's `callsPerRun` stay).
 */
export async function storeTerminalProviders(
  ex: Executor,
  rows: TerminalProviderRow[],
): Promise<void> {
  await exec(
    ex,
    `update ingest.sync_state
        set extra = coalesce(extra, '{}'::jsonb) || jsonb_build_object('providers', $3::jsonb),
            updated_at = now()
      where source = $1 and stream = $2`,
    ['terminal', TERMINAL_PROVIDERS_STREAM, JSON.stringify(rows)],
  );
}

/** The provider rows stored by the last run (none yet = []). */
export async function readTerminalProviders(ex: Executor): Promise<TerminalProviderRow[]> {
  const r = await exec<{ providers: TerminalProviderRow[] | null }>(
    ex,
    `select extra->'providers' as providers from ingest.sync_state
      where source = 'terminal' and stream = $1`,
    [TERMINAL_PROVIDERS_STREAM],
  );
  return r.rows[0]?.providers ?? [];
}

export function createFleetTerminalJob(opts: FleetJobOptions = {}) {
  return async function runFleetTerminal(ctx: JobContext): Promise<JobResult> {
    const cfg = (opts.config ?? getConfig)();
    const mode = cfg.CONNECTOR_TERMINAL ?? 'off';
    const http = httpFor(ctx, opts.http);
    const resolve = machineResolver();
    const stale = staleThresholdsOf(cfg);
    let client: TerminalClient | null = null;
    const terminal = async () => {
      if (!client) {
        const only = await mappedVehicleRefs(ctx.pool, 'terminal');
        client = TerminalClient.forMode(mode, cfg, http, {
          only,
          log: (msg, data) => ctx.log.warn(msg, data),
        });
      }
      return client;
    };
    const step = { source: 'terminal' as const, mode, leaseSeconds: TERMINAL_LEASE_SECONDS };

    const posSpec: SyncStepSpec<TerminalPositionRaw, NormalizedPosition> = {
      ...step,
      stream: TERMINAL_POSITIONS_STREAM,
      poll: async (cursor) => (await terminal()).pollPositions(cursor),
      map: (raw) => mapTerminalPosition(raw),
      upsert: positionsUpsert(resolve, stale),
      afterRun: tickAfterRun(stale),
    };
    const statsSpec: SyncStepSpec<TerminalStatRaw, NormalizedVehicleStat> = {
      ...step,
      stream: TERMINAL_STATS_STREAM,
      poll: async (cursor) => (await terminal()).pollStats(cursor),
      map: (raw) => mapTerminalStat(raw),
      upsert: statsUpsert(resolve),
      afterRun: publishSyncStatus,
    };
    const faultsSpec: SyncStepSpec<TerminalFaultRaw, NormalizedVehicleStat> = {
      ...step,
      stream: TERMINAL_FAULTS_STREAM,
      poll: async (cursor) => (await terminal()).pollFaults(cursor),
      map: (raw) => mapTerminalFault(raw),
      upsert: statsUpsert(resolve),
      afterRun: publishSyncStatus,
    };
    const vehicles = vehicleListUpsert(resolve, publishSyncStatus);
    const vehiclesSpec: SyncStepSpec<TerminalVehicleRaw, NormalizedVehicle> = {
      ...step,
      stream: TERMINAL_VEHICLES_STREAM,
      minIntervalSeconds: TERMINAL_SLOW_STREAM_MIN_INTERVAL_SECONDS,
      poll: async (cursor) => (await terminal()).pollVehicles(cursor),
      map: (raw) => mapTerminalVehicle(raw, cfg.VEHICLE_KIND_TAGS),
      upsert: vehicles.upsert,
      afterRun: vehicles.afterRun,
    };
    const providersSpec: SyncStepSpec<TerminalProvidersRaw, TerminalProviderRow[]> = {
      ...step,
      stream: TERMINAL_PROVIDERS_STREAM,
      minIntervalSeconds: TERMINAL_SLOW_STREAM_MIN_INTERVAL_SECONDS,
      poll: async (cursor) => (await terminal()).pollProviders(cursor),
      map: (raw) => mapTerminalProviders(raw),
      upsert: (tx, rows) => storeTerminalProviders(tx, rows),
      afterRun: publishSyncStatus,
    };

    const positions = await runSyncStep(posSpec, ctx);
    const others: SyncStepResult[] = [];
    const rest = [statsSpec, faultsSpec, vehiclesSpec, providersSpec] as SyncStepSpec<
      unknown,
      unknown
    >[];
    for (const spec of rest) {
      if (ctx.now().getTime() >= ctx.deadline.getTime() || ctx.signal.aborted) break;
      others.push(await runSyncStep(spec, ctx));
    }
    return combineStepResults(positions, others);
  };
}

export const runFleetTerminal = createFleetTerminalJob();
