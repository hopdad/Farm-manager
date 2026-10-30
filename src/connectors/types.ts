/**
 * Connector contract (plan §5). Types, constants and small pure helpers; no runtime imports,
 * so `src/config.ts`, the vendor stand-in, the seed, the jobs and the tests can all import it.
 *
 * Owned by the foundation stage. The connectors agent implements `runSyncStep`
 * (src/connectors/sync-step.ts) and the per-source clients (src/connectors/<source>/).
 * Changes to this file go through the stage report, not a direct edit.
 */
import type { MultiPolygon } from 'geojson';
import type { DbTx } from '../db/client';
import type { NormalizedFault } from '../domain/fault-codes';
import type { MachineKind, PositionKind } from '../domain/fleet';
import type { OperationKind, OperationMeasurements, OperationProduct } from '../domain/operations';
import type { PinGeometry } from '../domain/pins';
import type { VehicleKind } from '../domain/vehicles';
import type { ForecastIssue, GridRef, Observation, WeatherStation } from '../domain/weather';
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

/**
 * The modes that make vendor calls (a stream that is 'off' makes none): the `mode` of
 * ingest.api_calls_daily and ingest.connector_orgs rows (1f). Budgets read sandbox/live only.
 */
export const COUNTED_MODES = [
  'sim',
  'replay',
  'sandbox',
  'live',
] as const satisfies readonly Mode[];
export type CountedMode = (typeof COUNTED_MODES)[number];

/**
 * Every outside source the app syncs from or writes to. Used as `source` in ingest.* and farm.*
 * rows. 1f.2 (docs/contracts-1f.md part B) adds the multi-vendor telematics sources: `geotab`
 * (MyGeotab), `aemp` (the generic ISO 15143-3 client; the provider is the external_refs
 * source_org), `cnh` (CNH FieldOps) and `terminal` (the Terminal aggregator).
 */
export const CONNECTOR_SOURCES = [
  'deere',
  'samsara',
  'motive',
  'nws',
  'qbo',
  'bushel',
  'drone',
  'geotab',
  'aemp',
  'cnh',
  'terminal',
] as const;
export type ConnectorSource = (typeof CONNECTOR_SOURCES)[number];

/**
 * The vehicle telematics connections (one mode key each, src/config.ts: CONNECTOR_SAMSARA, …):
 * trucks, pickups and machine telematics all come through these. Deere is a connection too
 * (CONNECTOR_DEERE) but keeps its own ports (fields, operations, breadcrumbs).
 */
export const TELEMATICS_SOURCES = [
  'samsara',
  'motive',
  'geotab',
  'aemp',
  'cnh',
  'terminal',
] as const satisfies readonly ConnectorSource[];
export type TelematicsSource = (typeof TELEMATICS_SOURCES)[number];

/** Truck telematics vendors the deprecated ELD_VENDOR may name (the CONNECTOR_ELD alias). */
export const TRUCK_VENDORS = [
  'samsara',
  'motive',
  'geotab',
  'terminal',
] as const satisfies readonly TelematicsSource[];
export type TruckVendor = (typeof TRUCK_VENDORS)[number];

/** Row sources that are not outside vendors. Rows with `demo` or `sim` are never exported (plan §4). */
export const LOCAL_SOURCES = ['app', 'import', 'demo', 'sim'] as const;
export type LocalSource = (typeof LOCAL_SOURCES)[number];
export type RowSource = ConnectorSource | LocalSource;

/**
 * @deprecated since 1f.2: every vendor has its own mode key (CONNECTOR_SAMSARA, …); ELD_VENDOR is
 * read only as the deprecated alias (src/config.ts). Kept for the 1a stand-in code paths.
 */
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
//   farm.machines (telematics)   samsara | motive | geotab | cnh
//                                              'machine'   vehicle / asset id  ''  (no org concept)
//   farm.machines (AEMP)         'aemp'        'machine'   ISO 15143-3 equipment id (serial / PIN)
//                                                                              the provider id ('cnh', 'kubota', 'samsara')
//   farm.machines (Terminal)     'terminal'    'machine'   Terminal vehicle id the Terminal connection id
//   farm.parties                 'deere'       'party'     Deere client id     Deere org id   (1f; unused in M0)
// 1f.2: one machine may carry refs from several sources (a Case IH combine on AEMP now and on
// CNH FieldOps later; a pickup on Samsara and Terminal); each sync resolves only its own.
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
// Ports (plan §5 "Common shape"). The ones M0, M1 and 1f need are spelled out; the rest arrive
// with their slices and follow the same `xxxSince(cursor) -> { items, cursor }` shape.
// No new external_refs kinds in 1f: operations and pins carry their own source_id.
// ---------------------------------------------------------------------------------------------

/** One page from a cursor feed. `cursor` is opaque to the caller and is stored in ingest.sync_state.cursor. */
export interface PollResult<T> {
  items: T[];
  /** Cursor to resume from next time. Return the input cursor unchanged when nothing new arrived. */
  cursor: string;
  /** True when the vendor says more pages are ready right now (e.g. Samsara `hasNextPage`). */
  hasMore?: boolean;
}

// ---- The vehicle telematics / GPS port (1f.2: vendor-neutral) --------------------------------
// One port for trucks, pickups and machine telematics, whatever the device: an ELD, a GPS-only
// tracker, an asset gateway, a carmaker cloud, an OEM's telematics feed (docs/contracts-1f.md
// part B). Farm trucks may legally run without an ELD and the regulated ELD transfer is not a
// third-party feed, so nothing here is keyed to ELDs. Units are normalized (hours, miles,
// percent, mph); the vendor's own number and its raw/adjusted flag ride along in `readings`.

/** A normalized position fix. Timestamps are WALL-CLOCK UTC ISO strings, also in sim mode. */
export interface NormalizedPosition {
  source: ConnectorSource;
  /** Vendor's vehicle/machine id; mapped to farm.machines.id through ingest.external_refs. */
  externalMachineId: string;
  /**
   * external_refs.source_org of the machine: the Deere org id it was read from; the AEMP
   * provider id; the Terminal connection id; '' for vendors with no org concept.
   */
  sourceOrg: string;
  ts: string;
  lng: number;
  lat: number;
  /** Degrees clockwise from true north, [0, 360). */
  heading: number | null;
  speedMph: number | null;
  engineOn: boolean | null;
  /**
   * Deere reports breadcrumbs only while working; telematics devices report all the time
   * (`eld` = any vehicle telematics device, src/domain/fleet.ts POSITION_SOURCES).
   */
  positionSource: 'eld' | 'deere_working' | 'cab_device' | 'manual';
  /**
   * 1f.2: `live` (default) = a trail point; `last_known` = a vendor snapshot of where the machine
   * was last seen (AEMP, Terminal's latest location): machine_state only, never farm.positions.
   */
  positionKind?: PositionKind;
  /**
   * 1f.2: the provider behind an aggregator route (AEMP provider, Terminal's TSP), so
   * machine_state.position_vendor reads `aemp_kubota` (`positionVendorId`, src/domain/fleet.ts).
   */
  provider?: string | null;
}

/** The stats fields of the port (capabilities name these; the panel shows "not reported"). */
export const VEHICLE_STAT_FIELDS = [
  'engineHours',
  'odometerMi',
  'fuelPct',
  'defPct',
  'engineOn',
] as const;
export type VehicleStatField = (typeof VEHICLE_STAT_FIELDS)[number];

/** Units a vendor reports stats in (StatReading.rawUnit). */
export const STAT_RAW_UNITS = [
  'seconds',
  'minutes',
  'hours',
  'meters',
  'kilometers',
  'miles',
  'percent',
  'boolean',
] as const;
export type StatRawUnit = (typeof STAT_RAW_UNITS)[number];

/**
 * Where a normalized stat came from (1f.2): the vendor's own number and unit, and whether the
 * vendor says it was adjusted. `adjusted` = true for a calibrated or offset value (Motive
 * `true_engine_hours` / `true_odometer`, Samsara synthetic or offset engine seconds, a Geotab
 * StatusData adjustment), false for the raw ECU or gateway count (Samsara `obdEngineSeconds`,
 * `gatewayJ1939EngineSeconds`), null when the vendor doesn't say.
 */
export interface StatReading {
  raw: number | boolean;
  rawUnit: StatRawUnit;
  adjusted: boolean | null;
  /** The vendor field it came from ('true_engine_hours', 'obdEngineSeconds', 'CumulativeOperatingHours'). */
  field: string;
}

/** Normalize a raw number to the port's units: hours, miles or percent (booleans pass through). */
export function normalizeStat(raw: number, unit: StatRawUnit): number {
  switch (unit) {
    case 'seconds':
      return raw / 3600;
    case 'minutes':
      return raw / 60;
    case 'hours':
    case 'miles':
    case 'percent':
      return raw;
    case 'meters':
      return raw / 1609.344;
    case 'kilometers':
      return raw / 1.609344;
    case 'boolean':
      return raw ? 1 : 0;
  }
}

/** Engine hours, odometer, fuel, DEF, engine state and faults (telematics stats, Deere hours). */
export interface NormalizedVehicleStat {
  source: ConnectorSource;
  externalMachineId: string;
  /** As in NormalizedPosition (Deere org, AEMP provider, Terminal connection, or ''). */
  sourceOrg: string;
  /** Vendor time of the reading (wall-clock UTC ISO). */
  ts: string;
  /** Hours (normalized). */
  engineHours?: number;
  /** Miles (normalized). */
  odometerMi?: number;
  /** 0-100. */
  fuelPct?: number;
  /** 1f.2: diesel exhaust fluid level, 0-100. */
  defPct?: number;
  /** 1f.2: the engine is running at `ts`. */
  engineOn?: boolean;
  /** 1f.2: the vendor's raw value, unit and raw/adjusted flag per field set above. */
  readings?: Partial<Record<VehicleStatField, StatReading>>;
  /**
   * The machine's fault codes at `ts` in the one fault model (src/domain/fault-codes.ts: J1939,
   * OBD-II, OEM; severity by decision 1f-2 per system). Read with `faultReport`. Absent = this
   * event says nothing about faults (a fuel or hours reading).
   */
  faultCodes?: NormalizedFault[];
  /**
   * How to read `faultCodes` (default `snapshot`):
   *  - `snapshot`: the complete ACTIVE set at `ts` (Samsara's faultCodes stat); a code it no
   *    longer lists has cleared; `[]` = cleared (no codes, no lamps).
   *  - `delta`: only the faults named, each with its own `state` and times (Motive, Geotab,
   *    AEMP, Terminal); codes it doesn't name are unchanged.
   */
  faultReport?: 'snapshot' | 'delta';
}

/** One vehicle as the vendor lists it (kind from tags, via) → farm.machines.kind / telematics_via. */
export interface NormalizedVehicle {
  source: ConnectorSource;
  sourceOrg: string;
  externalId: string;
  name: string;
  /** The vendor's tags / groups, verbatim (VEHICLE_KIND_TAGS matches on these). */
  tags: string[];
  /** `vehicleKindFromTags(tags, rules)` (src/domain/vehicles.ts), or null: kind unchanged. */
  kindFromTags: VehicleKind | null;
  /** How the vendor gets its data (src/domain/vehicles.ts TELEMATICS_VIAS), when it says. */
  via: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  vin: string | null;
}

export interface PositionSource {
  poll(cursor: string | null): Promise<PollResult<NormalizedPosition>>;
}
export interface VehicleStatsSource {
  statsSince(cursor: string | null): Promise<PollResult<NormalizedVehicleStat>>;
}

/**
 * The vendor-neutral vehicle telematics port (1f.2). Each connection implements what its
 * capability matrix (src/connectors/vendors.ts) says it has; jobs call it through runSyncStep
 * (poll = raw items, map = these normalized types), one stream per method:
 * `positions`, `stats`, `faults`, `vehicles`. Cursors follow one of the two sync models of
 * src/connectors/sync-models.ts (cursor/version feed, or snapshot diff).
 */
export interface VehicleTelematicsSource {
  positions(cursor: string | null): Promise<PollResult<NormalizedPosition>>;
  stats?(cursor: string | null): Promise<PollResult<NormalizedVehicleStat>>;
  /** Stats items that carry `faultCodes` (and `faultReport`) only. */
  faults?(cursor: string | null): Promise<PollResult<NormalizedVehicleStat>>;
  vehicles?(): Promise<NormalizedVehicle[]>;
}

// ---- 1f: Deere fields, boundaries, flags, operations, equipment ------------------------------
// Every item names the vendor org it was read from (`sourceOrg`, the external_refs source_org)
// and the vendor's own id (`externalId`). Times are UTC ISO strings. Mapped by the deere-data
// and deere-ops builders (docs/contracts-1f.md §5); upserted with deterministic ids.

/** A vendor-side grouping reference (a Deere farm or client) carried on a field. */
export interface NormalizedRef {
  externalId: string;
  name: string;
}

/** One field boundary as the vendor holds it (D6: an active Deere boundary is the master). */
export interface NormalizedBoundary {
  source: ConnectorSource;
  sourceOrg: string;
  /** Vendor boundary id (external_refs kind 'boundary'). */
  externalId: string;
  /** Vendor field id the boundary belongs to. */
  fieldExternalId: string;
  name: string | null;
  /** EPSG:4326; Polygon rings from the vendor become one MultiPolygon. */
  geom: MultiPolygon;
  /** Area the vendor reports, acres (the app computes its own from `geom`). */
  areaAc: number | null;
  active: boolean;
  archived: boolean;
  modifiedAt: string | null;
}

/** One field (FieldSource; external_refs kind 'field', one row per org that has the field). */
export interface NormalizedField {
  source: ConnectorSource;
  sourceOrg: string;
  /** Vendor field id. */
  externalId: string;
  name: string;
  /** The vendor farm the field is in (Deere farms; null when the vendor doesn't say). */
  farm: NormalizedRef | null;
  /** The vendor client (a custom-work customer: farm.parties via kind 'party'), or null. */
  client: NormalizedRef | null;
  archived: boolean;
  /** The field's active boundary, or null when it has none. */
  boundary: NormalizedBoundary | null;
  modifiedAt: string | null;
}

/** One flag → a read-only pin (FlagSource; pins.source 'deere_flag'). */
export interface NormalizedFlag {
  source: ConnectorSource;
  sourceOrg: string;
  /** Vendor flag id (pins.source_id). */
  externalId: string;
  /** Vendor field id the flag is on, or null. */
  fieldExternalId: string | null;
  geometry: PinGeometry;
  note: string | null;
  /** The vendor's category or label (pins.category), or null. */
  category: string | null;
  /** Archived in the vendor = resolved here. */
  archived: boolean;
  createdAt: string | null;
  modifiedAt: string | null;
}

/** One field operation (OperationSource; farm.operations). */
export interface NormalizedOperation {
  source: ConnectorSource;
  sourceOrg: string;
  /** Vendor operation id (operations.source_id). */
  externalId: string;
  /** Vendor field id, or null when the vendor doesn't link one. */
  fieldExternalId: string | null;
  kind: OperationKind;
  cropYear: number;
  /** Normalized crop (src/domain/crops.ts, deere-ops), or null. */
  crop: string | null;
  startedAt: string;
  endedAt: string | null;
  /** Area worked as the vendor reports it, acres. */
  areaAc: number | null;
  products: OperationProduct[];
  measurements: OperationMeasurements;
  /** Vendor machine ids (resolved through external_refs kind 'machine'). */
  machineExternalIds: string[];
  operatorName: string | null;
  /** Coverage, EPSG:4326 (simplified when stored), or null when the vendor has none. */
  coverage: MultiPolygon | null;
  modifiedAt: string | null;
}

/** One machine of the vendor's equipment list (creates farm.machines rows for unmapped ones). */
export interface NormalizedMachine {
  source: ConnectorSource;
  sourceOrg: string;
  /** Vendor machine id (external_refs kind 'machine'). */
  externalId: string;
  name: string;
  /** Null when the vendor's type doesn't map to a MachineKind (the row is then skipped, logged). */
  kind: MachineKind | null;
  make: string | null;
  model: string | null;
  year: number | null;
  vin: string | null;
}

/** Plan §5: every field the connection can see (with its active boundary). */
export interface FieldSource {
  listFields(): Promise<NormalizedField[]>;
}
/** Plan §5: flags changed after the cursor. */
export interface FlagSource {
  flagsSince(cursor: string | null): Promise<PollResult<NormalizedFlag>>;
}
/** Plan §5: operations changed after the cursor. */
export interface OperationSource {
  operationsSince(cursor: string | null): Promise<PollResult<NormalizedOperation>>;
}
/** The vendor's machines (Deere equipment); engine hours come as NormalizedVehicleStat. */
export interface MachineSource {
  listMachines(): Promise<NormalizedMachine[]>;
}

/**
 * NWS forecasts and observations (1b; weather builder, src/connectors/nws/**). Units are US
 * customary (the client converts NWS's SI). In sim mode the same client talks to the NWS
 * stand-in (/nws on VENDOR_SIM_URL); a User-Agent with contact info is required (NWS_USER_AGENT).
 */
export interface ForecastSource {
  /** `/points/{lat},{lon}` -> the grid cell and its nearest stations (cache it: farm.weather_grids). */
  gridFor(lng: number, lat: number): Promise<{ grid: GridRef; stations: WeatherStation[] }>;
  /** `forecastGridData` of one cell, one entry per hour, with the issue time. */
  hourly(grid: GridRef): Promise<ForecastIssue>;
  /** Observations of one station after `since`. */
  observations(stationId: string, since: Date): Promise<Observation[]>;
}

/** Soil temperature (D5, 2b): manual readings first; a station or probe API later. */
export interface SoilTempSource {
  latest(near: { lng: number; lat: number }): Promise<{
    tempF: number;
    depthIn: number;
    observedAt: string;
  } | null>;
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
  /** The configured mode (e.g. getConfig().CONNECTOR_SAMSARA); written to sync_state.mode. */
  mode: Mode;
  /** Lease length; must exceed the job budget. Default 90 s. */
  leaseSeconds?: number;
  /** Attempts before a raw event goes to 'dead'. Default 5. */
  maxAttempts?: number;
  /**
   * 1f, decision 4 (call budget): after a claimed run the stream is not due again sooner than
   * this many seconds after the run started (released with next_run_at = the later of that and a
   * Retry-After time). Never makes a stream run faster than its job's cadence. Undefined or null
   * = no minimum (the job's cadence alone). Implemented by runSyncStep (sync-health).
   */
  minIntervalSeconds?: number | null;
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
