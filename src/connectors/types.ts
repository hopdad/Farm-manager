/**
 * Connector contract (plan §5). Types, constants and small pure helpers; no runtime imports,
 * so `src/config.ts`, the vendor stand-in, the seed, the jobs and the tests can all import it.
 *
 * Owned by the foundation stage. The connectors agent implements `runSyncStep`
 * (src/connectors/sync-step.ts) and the per-source clients (src/connectors/<source>/).
 * Changes to this file go through the stage report, not a direct edit.
 */
import type { DbTx } from '../db/client';
import type { JobContext } from '../jobs/types';

/** Lease helpers and the camelCase lease row live in src/db/leases.ts (re-exported here). */
export type { ClaimedLease } from '../db/leases';

/**
 * How a connector runs.
 * - `sim`: the LIVE client pointed at the local vendor stand-in (VENDOR_SIM_URL/<vendor>).
 * - `replay`: recorded or doc-derived fixtures, offline.
 * - `sandbox`: the vendor's sandbox (where one exists).
 * - `live`: the real vendor.
 * - `off`: the job claims nothing and returns `{ items: 0, note: 'off' }`.
 * `src/config.ts` refuses `sim` and `replay` when APP_ENV=production.
 */
export const CONNECTOR_MODES = ['sim', 'replay', 'sandbox', 'live', 'off'] as const;
export type Mode = (typeof CONNECTOR_MODES)[number];

/** Every outside source the app syncs from or writes to. Used as `source` in ingest.* and farm.* rows. */
export const CONNECTOR_SOURCES = [
  'deere',
  'samsara',
  'motive',
  'nws',
  'qbo',
  'bushel',
  'drone',
] as const;
export type ConnectorSource = (typeof CONNECTOR_SOURCES)[number];

/** Row sources that are not outside vendors. Rows with `demo` or `sim` are never exported (plan §4). */
export const LOCAL_SOURCES = ['app', 'import', 'demo', 'sim'] as const;
export type LocalSource = (typeof LOCAL_SOURCES)[number];
export type RowSource = ConnectorSource | LocalSource;

/** The ELD vendor behind CONNECTOR_ELD (config: ELD_VENDOR). */
export type EldVendor = Extract<ConnectorSource, 'samsara' | 'motive'>;

// ---------------------------------------------------------------------------------------------
// ingest.external_refs vocabulary: vendor id -> our entity id. The seed (scripts/seed.ts) writes
// these rows and every sync reads them, so both MUST build refs with `externalRef()` and the
// kinds below. Exact tuples for the simulated farm: `simExternalRefs()` in src/sim/types.ts.
// DB access: src/db/external-refs.ts (upsertExternalRef, resolveExternalRef(s)).
//
//   entity                       source        kind        external_id         source_org
//   farm.farms                   'deere'       'farm'      Deere farm id       Deere org id
//   farm.fields                  'deere'       'field'     Deere field id      Deere org id (one row per org that has the field)
//   farm.field_boundaries        'deere'       'boundary'  Deere boundary id   Deere org id
//   farm.machines (JDLink)       'deere'       'machine'   Deere machine id    Deere org id
//   farm.machines (ELD vehicle)  ELD_VENDOR    'machine'   vehicle id          ''  (no org concept)
//   farm.parties                 'deere'       'party'     Deere client id     Deere org id   (1f; unused in M0)
// ---------------------------------------------------------------------------------------------

/** `kind` values of ingest.external_refs. Add one by reporting it (contracts §4). */
export const EXTERNAL_REF_KINDS = ['party', 'farm', 'field', 'boundary', 'machine'] as const;
export type ExternalRefKind = (typeof EXTERNAL_REF_KINDS)[number];

/** One ingest.external_refs key. `sourceOrg` is '' when the vendor has no org concept (ELDs). */
export interface ExternalRef {
  source: ConnectorSource;
  kind: ExternalRefKind;
  externalId: string;
  sourceOrg: string;
}

/** Build (and check) an external ref key. Use this in both the seed and every sync. */
export function externalRef(
  source: ConnectorSource,
  kind: ExternalRefKind,
  externalId: string,
  sourceOrg = '',
): ExternalRef {
  if (!(CONNECTOR_SOURCES as readonly string[]).includes(source)) {
    throw new Error(`externalRef: unknown source '${source}'`);
  }
  if (!(EXTERNAL_REF_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`externalRef: unknown kind '${kind}'`);
  }
  if (!externalId) throw new Error(`externalRef: empty external id (${source}/${kind})`);
  if (source === 'deere' && !sourceOrg) {
    throw new Error(
      `externalRef: Deere refs need the Deere org id as sourceOrg (${kind} ${externalId})`,
    );
  }
  return { source, kind, externalId, sourceOrg };
}

/** Stable string form of a ref, for Maps and logs: `source|kind|sourceOrg|externalId`. */
export function externalRefKey(
  source: ConnectorSource,
  kind: ExternalRefKind,
  externalId: string,
  sourceOrg = '',
): string {
  return `${source}|${kind}|${sourceOrg}|${externalId}`;
}

// ---------------------------------------------------------------------------------------------
// Ports (plan §5 "Common shape"). Only the ones M0 needs are spelled out; the rest arrive with
// their slices and follow the same `xxxSince(cursor) -> { items, cursor }` shape.
// ---------------------------------------------------------------------------------------------

/** One page from a cursor feed. `cursor` is opaque to the caller and is stored in ingest.sync_state.cursor. */
export interface PollResult<T> {
  items: T[];
  /** Cursor to resume from next time. Return the input cursor unchanged when nothing new arrived. */
  cursor: string;
  /** True when the vendor says more pages are ready right now (e.g. Samsara `hasNextPage`). */
  hasMore?: boolean;
}

/** A normalized position fix. Timestamps are WALL-CLOCK UTC ISO strings, also in sim mode. */
export interface NormalizedPosition {
  source: ConnectorSource;
  /** Vendor's vehicle/machine id; mapped to farm.machines.id through ingest.external_refs. */
  externalMachineId: string;
  /** external_refs.source_org of the machine: the Deere org id it was read from; '' for ELDs. */
  sourceOrg: string;
  ts: string;
  lng: number;
  lat: number;
  /** Degrees clockwise from true north, [0, 360). */
  heading: number | null;
  speedMph: number | null;
  engineOn: boolean | null;
  /** Deere reports breadcrumbs only while working; ELDs report all the time. */
  positionSource: 'eld' | 'deere_working' | 'cab_device' | 'manual';
}

/** Engine hours, odometer, fuel and faults (ELD stats feed, Deere machine hours). */
export interface NormalizedVehicleStat {
  source: ConnectorSource;
  externalMachineId: string;
  /** As in NormalizedPosition: the Deere org id, '' for ELDs. */
  sourceOrg: string;
  ts: string;
  engineHours?: number;
  odometerMi?: number;
  fuelPct?: number;
  faultCodes?: { code: string; severity: 'info' | 'warning' | 'critical'; description?: string }[];
}

export interface PositionSource {
  poll(cursor: string | null): Promise<PollResult<NormalizedPosition>>;
}
export interface VehicleStatsSource {
  statsSince(cursor: string | null): Promise<PollResult<NormalizedVehicleStat>>;
}

// ---------------------------------------------------------------------------------------------
// The one sync step every source uses (plan §5). runSyncStep runs INSIDE a job's run(ctx); the
// jobs route has already claimed the JOB lease ('job', <job name>) before answering 202
// (src/db/leases.ts, contracts §5). runSyncStep owns only the STREAM lease (source, stream):
//   0. ensureStream(ctx.pool, source, stream, spec.mode). If spec.mode is 'off', return
//      { claimed: false, ... } without polling; the job returns { items: 0, note: 'off' }.
//   1. claim the stream lease: claimDue(ctx.pool, source, stream, spec.leaseSeconds ?? 90).
//      null -> return { claimed: false, ... }; the job returns { items: 0, note: 'lease held elsewhere' }.
//   2. poll(cursorOf(lease)).
//   3. ONE transaction: insert raw payloads into ingest.raw_events
//      (on conflict (source, stream, external_id, sha256) do nothing) and
//      advanceCursor(tx, lease, cursor). advanceCursor false = lease lost: roll back, stop.
//   4. process pending raw events one at a time, each in its own transaction:
//      map (pure) -> upsert through ingest.external_refs (src/db/external-refs.ts) with
//      deterministic ids -> mark processed. A failure increments attempts; at maxAttempts the
//      event becomes 'dead'. Stop taking new events after ctx.deadline.
//   5. releaseLease(ctx.pool, lease, { ok, error, nextRunAt }).
//   6. afterRun (e.g. publish ONE batched fleet.tick) whenever the lease was claimed, ok or not.
// Nothing here ever claims the job row, and the route never claims a stream row.
// A crash at any point re-runs safely; one huge payload can't stall the cursor.
//
// FAILURES (so the "trucks API down -> trucks go stale with a badge" demo works end to end):
//  - Before the claim (steps 0-1) runSyncStep lets database errors throw; nothing is held.
//  - After the claim it NEVER throws for a poll, landing or lease-lost failure. It catches the
//    error, releases with `{ ok: false, error, nextRunAt }` and returns
//    `{ claimed: true, ok: false, error, ... }`. `nextRunAt` = now + `retryAfterSeconds` when
//    the thrown error carries that numeric property (429/503 Retry-After), else null (the job's
//    own cadence is the backoff). Lease lost (advanceCursor false) = `error: 'lease lost'`.
//  - Per-event map/upsert failures are NOT step failures: they count attempts / `dead`, ok stays
//    true.
//  - afterRun runs AFTER releaseLease whenever claimed (also when ok is false), so the board keeps
//    getting ticks (with `stale` recomputed) during a vendor outage. If afterRun throws, the
//    error is logged and returned as `ok: false, error: 'afterRun: <message>'` (the stream's
//    sync_state already holds the poll outcome).
//  - The job turns the result into its JobResult with `syncStepJobResult()` below: skipped ->
//    `{ items: 0, note }`, !ok -> throws SyncStepError (the route records ok=false in
//    ingest.job_runs), else `{ items: processed, note? }`.
// ---------------------------------------------------------------------------------------------

/** One raw item as fetched, before mapping. Landed verbatim in ingest.raw_events.payload. */
export interface RawItem<TRaw = unknown> {
  /** Vendor id of the record (or a stable synthetic one, e.g. `${vehicleId}:${time}`). */
  externalId: string;
  payload: TRaw;
}

/** Passed to every hook of a sync step. */
export interface SyncContext {
  job: JobContext;
  source: ConnectorSource;
  stream: string;
  mode: Mode;
}

/** What a connector supplies to `runSyncStep`. */
export interface SyncStepSpec<TRaw = unknown, TNorm = unknown> {
  source: ConnectorSource;
  /** Stream name within the source, e.g. 'positions', 'stats', 'fields', 'operations'. */
  stream: string;
  /** The configured mode (e.g. getConfig().CONNECTOR_ELD); written to sync_state.mode. */
  mode: Mode;
  /** Lease length; must exceed the job budget. Default 90 s. */
  leaseSeconds?: number;
  /** Attempts before a raw event goes to 'dead'. Default 5. */
  maxAttempts?: number;
  /** Fetch the next page(s) after `cursor`. Must not write to the database. */
  poll(cursor: string | null, ctx: SyncContext): Promise<PollResult<RawItem<TRaw>>>;
  /** Pure mapping of one raw payload. Return [] to skip it (it is still marked processed). */
  map(raw: TRaw, ctx: SyncContext): TNorm[];
  /** Upsert one normalized item inside the per-event transaction. */
  upsert(tx: DbTx, item: TNorm, ctx: SyncContext): Promise<void>;
  /**
   * Optional hook, called after releaseLease whenever the lease was claimed, whether the poll
   * succeeded or not (check `result.ok`). Typical use: publish ONE batched fleet.tick built from
   * farm.machine_state with `stale` recomputed, so an outage shows up on the board.
   * Not called when nothing was claimed (skipped).
   */
  afterRun?(result: SyncStepResult, ctx: SyncContext): Promise<void>;
}

export interface SyncStepResult {
  /** False when another runner held the lease, the stream is 'off', or it isn't due yet. */
  claimed: boolean;
  /**
   * False only when claimed and the step failed: poll threw, landing failed, the lease was lost,
   * or afterRun threw. True when skipped (nothing failed) and when only individual events failed
   * (those count in `dead` / attempts).
   */
  ok: boolean;
  /** Short reason when !ok (no secrets): the poll/landing error message, 'lease lost', 'afterRun: …'. */
  error?: string;
  /** Why nothing ran when !claimed: 'off' or 'lease held elsewhere' (use it as JobResult.note). */
  skipped?: 'off' | 'lease held elsewhere';
  /** Raw events newly inserted this run (duplicates by sha256 don't count); 0 if landing failed. */
  landed: number;
  /** Raw events processed this run (including ones landed by earlier runs). */
  processed: number;
  /** Raw events that crossed maxAttempts this run. */
  dead: number;
  /** The stream's cursor after this run (unchanged when the poll or landing failed). */
  cursor: string | null;
}

/** Thrown by `syncStepJobResult` for a failed step, so the jobs route records ok=false. */
export class SyncStepError extends Error {
  readonly result: SyncStepResult;
  constructor(result: SyncStepResult) {
    super(result.error ?? 'sync step failed');
    this.name = 'SyncStepError';
    this.result = result;
  }
}

/**
 * SyncStepResult -> JobResult, the same way in every job:
 *   skipped           -> { items: 0, note: 'off' | 'lease held elsewhere' }
 *   claimed, !ok      -> throws SyncStepError(result) (ingest.job_runs gets ok=false + the error)
 *   claimed, ok       -> { items: processed, note: '<n> dead-lettered' when dead > 0 }
 */
export function syncStepJobResult(r: SyncStepResult): { items: number; note?: string } {
  if (!r.claimed) return { items: 0, note: r.skipped ?? 'not claimed' };
  if (!r.ok) throw new SyncStepError(r);
  return r.dead > 0
    ? { items: r.processed, note: `${r.dead} dead-lettered` }
    : { items: r.processed };
}

/**
 * Release time after a failed poll: now + `retryAfterSeconds` when the error carries that
 * numeric property (vendor 429/503 Retry-After), else null (due again at the next tick).
 */
export function retryAfterFrom(err: unknown, now: Date): Date | null {
  const s = (err as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return null;
  return new Date(now.getTime() + Math.ceil(s) * 1000);
}

/**
 * Signature of the shared helper the connectors agent implements in
 * src/connectors/sync-step.ts. Jobs call it from their `run(ctx)`.
 */
export type RunSyncStep = <TRaw, TNorm>(
  spec: SyncStepSpec<TRaw, TNorm>,
  ctx: JobContext,
) => Promise<SyncStepResult>;
