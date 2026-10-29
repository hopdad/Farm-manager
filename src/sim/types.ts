/**
 * The simulated-world API shared by the vendor stand-in (tools/vendor-sim, src/sim/vendors/*),
 * the demo seed (scripts/seed.ts) and the tests. Plan §5 "Simulator".
 *
 * Owned by the foundation stage; the sim agent implements it in src/sim/** and exports the
 * factories from src/sim/index.ts. Changes to this file go through the stage report.
 *
 * ---------------------------------------------------------------------------------------
 * THE TIME RULE (read this first)
 *   The world advances in SIM time; every timestamp the stand-in reports is WALL-CLOCK time.
 *   For a request at wall time `w`, the stand-in samples `world.machineAt(id, clock.wallToSim(w))`
 *   and stamps the sample with `w`. So a 30x day still produces real "now" timestamps, the app's
 *   staleness logic (wall clock) stays correct, pausing the sim freezes machines without making
 *   them stale, and a vendor outage makes them stale without freezing sim time.
 * ---------------------------------------------------------------------------------------
 *
 * Determinism: world state is a pure function of (scenario, seed, sim time[, work plans from
 * M2]). Nothing ticks in the background. `farm` depends only on `seed`, never on the scenario,
 * so one seeded database serves every scenario.
 *
 * Ids: every SimFarm id is `demoId(key)` from src/domain/ids.ts (= uuidv5('demo:' + key)).
 * The seed writes rows with id = that id, source = 'demo', source_id = key, plus one
 * ingest.external_refs row per vendor id below, so synced vendor data maps onto seeded rows.
 *
 * External refs (the seam between the seed and the vendors' syncs): the seed writes EXACTLY the
 * rows `simExternalRefs(farm, ELD_VENDOR)` returns, through upsertExternalRef()
 * (src/db/external-refs.ts); syncs look vendor ids up with the same tuples:
 *   farm      ('deere', 'farm',     SimFarmUnit.deereFarmId,  SimFarmUnit.deereOrgId)     -> SimFarmUnit.id
 *   field     ('deere', 'field',    SimField.deereFieldId,    owning unit's deereOrgId)   -> SimField.id
 *             ('deere', 'field',    sharedWith.deereFieldId,  sharedWith.deereOrgId)      -> SimField.id (same field)
 *   boundary  ('deere', 'boundary', SimField.deereBoundaryId, owning unit's deereOrgId)   -> SimField.boundaryId
 *   machine   ('deere', 'machine',  vendorIds.deere,          SimMachine.deereOrgId)      -> SimMachine.id
 *   machine   (ELD_VENDOR, 'machine', vendorIds.eld,          '')                         -> SimMachine.id
 * The Deere stand-in serves each org's data under that org id, so the org a sync reads from IS
 * the source_org it looks up. M0 machines all live in SIM_DEERE_HOME_ORG.
 */
import type { MultiPolygon, Polygon } from 'geojson';
import { type EldVendor, type ExternalRef, externalRef as ref } from '../connectors/types';
import type { PartyKind, PartyRole, Tenure } from '../domain/farm';
import type { Activity, MachineKind } from '../domain/fleet';

export const SCENARIO_NAMES = [
  'harvest-day',
  'winter-idle',
  'planting-day',
  'spray-windy',
  'breakdown',
  'bad-morning',
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** [longitude, latitude] in WGS84 (EPSG:4326). */
export type LngLat = [lng: number, lat: number];

/** Deere org id of your own operation in the simulated world; customer orgs are 'org-customer-<n>'. */
export const SIM_DEERE_HOME_ORG = 'org-home';

// ---------------------------------------------------------------------------------------------
// The simulated farm (static for a given seed)
// ---------------------------------------------------------------------------------------------

export interface SimParty {
  id: string;
  /** Stable key, e.g. 'landlord-kowalski', 'elevator-raisin', 'crew-dan'. Also the seed's source_id. */
  key: string;
  kind: PartyKind;
  displayName: string;
  roles: PartyRole[];
  /** Organization this person belongs to (farm.parties.org_id), or null. */
  orgId: string | null;
  phone?: string;
  email?: string;
}

/** A farm.farms row: one per client in Operations Center terms (null client = your own farm). */
export interface SimFarmUnit {
  id: string;
  key: string;
  name: string;
  /** Customer party for custom-work farms; null for your own operation. */
  clientPartyId: string | null;
  /** Deere Operations Center farm id (vendor id; also an external_refs row). */
  deereFarmId: string;
  /** Deere organization the farm lives in: SIM_DEERE_HOME_ORG or a customer org such as 'org-customer-1'. */
  deereOrgId: string;
}

export interface SimField {
  id: string;
  key: string;
  /** Display name as the crew says it, e.g. 'Kowalski North 80'. */
  name: string;
  farmId: string;
  tenure: Tenure;
  landlordPartyId: string | null;
  /** 26091 = Lenawee, 26115 = Monroe. */
  countyFips: '26091' | '26115';
  /** Field boundary in EPSG:4326. M0: quarter / half-quarter sections on the 1-mile grid. */
  boundary: MultiPolygon;
  /** Approximate acres (geodesic). The database trigger computes the stored value. */
  acres: number;
  /** Where machines enter the field from the section-line road. */
  entrance: LngLat;
  /** Road-graph node at the entrance. */
  entranceNodeId: string;
  /** Deere field id in the owning org (vendor id; also an external_refs row). */
  deereFieldId: string;
  /** Deere boundary id of the active boundary (vendor id). */
  deereBoundaryId: string;
  /**
   * Id of the seeded current farm.field_boundaries row: demoId(`boundary:${key}`), seeded with
   * source = 'demo', source_id = `boundary:${key}`.
   */
  boundaryId: string;
  /** Second org that also has this field (field-matching tests), with its own field id there. */
  sharedWith?: { deereOrgId: string; deereFieldId: string };
}

export interface SimMachine {
  id: string;
  key: string;
  kind: MachineKind;
  /** Painted unit number, e.g. 'C1' (combine 1), 'GC2' (grain cart 2), 'S3' (semi 3). */
  unitNo: string;
  make: string;
  model: string;
  year: number;
  /**
   * Vendor ids. `deere` = Equipment API machine id (machines with JDLink).
   * `eld` = vehicle id in the ELD vendor selected by ELD_VENDOR (trucks, and any machine with an ELD).
   * A machine with neither has no live position (manual only).
   */
  vendorIds: { deere?: string; eld?: string };
  /** Deere org the machine is registered in. Required when vendorIds.deere is set (M0: SIM_DEERE_HOME_ORG). */
  deereOrgId?: string;
  /** Implement / header width for working passes. */
  implementWidthFt?: number;
}

export interface SimElevator {
  id: string;
  key: string;
  /** farm.parties row of the elevator company (role 'elevator'). */
  partyId: string;
  name: string;
  /** Yard polygon used as the farm.geofences row (kind 'elevator'). */
  geofence: Polygon;
  /** Where trucks enter the yard from the road. */
  entrance: LngLat;
  entranceNodeId: string;
}

export interface SimShop {
  id: string;
  name: string;
  location: LngLat;
  /** farm.geofences row (kind 'shop'). */
  geofence: Polygon;
  nodeId: string;
}

/** Section-line road network (1-mile grid) the trucks drive on. */
export interface RoadNode {
  id: string;
  lngLat: LngLat;
}
export interface RoadEdge {
  from: string;
  to: string;
  lengthMi: number;
  name?: string;
}
export interface RoadGraph {
  nodes: RoadNode[];
  edges: RoadEdge[];
}

export interface SimFarm {
  parties: SimParty[];
  farms: SimFarmUnit[];
  fields: SimField[];
  machines: SimMachine[];
  elevators: SimElevator[];
  shop: SimShop;
  roads: RoadGraph;
}

/** One ingest.external_refs row the seed writes for the simulated farm. */
export interface SimExternalRefRow {
  ref: ExternalRef;
  entityId: string;
  /** Which farm.* table entityId points into. */
  entity: 'farm' | 'field' | 'field_boundary' | 'machine';
}

/**
 * Every external ref of the simulated farm, with the exact tuples documented at the top of this
 * file. The seed writes these; vendor-sync tests can assert that what they read maps through
 * them. Pure: depends only on `farm` and the ELD vendor (config ELD_VENDOR).
 */
export function simExternalRefs(farm: SimFarm, eldVendor: EldVendor): SimExternalRefRow[] {
  const orgOfFarm = new Map(farm.farms.map((u) => [u.id, u.deereOrgId]));
  const rows: SimExternalRefRow[] = [];
  for (const u of farm.farms) {
    rows.push({
      ref: ref('deere', 'farm', u.deereFarmId, u.deereOrgId),
      entityId: u.id,
      entity: 'farm',
    });
  }
  for (const f of farm.fields) {
    const org = orgOfFarm.get(f.farmId);
    if (!org) throw new Error(`simExternalRefs: field ${f.key} has unknown farm ${f.farmId}`);
    rows.push({ ref: ref('deere', 'field', f.deereFieldId, org), entityId: f.id, entity: 'field' });
    if (f.sharedWith) {
      rows.push({
        ref: ref('deere', 'field', f.sharedWith.deereFieldId, f.sharedWith.deereOrgId),
        entityId: f.id,
        entity: 'field',
      });
    }
    rows.push({
      ref: ref('deere', 'boundary', f.deereBoundaryId, org),
      entityId: f.boundaryId,
      entity: 'field_boundary',
    });
  }
  for (const m of farm.machines) {
    if (m.vendorIds.deere) {
      rows.push({
        ref: ref('deere', 'machine', m.vendorIds.deere, m.deereOrgId ?? ''),
        entityId: m.id,
        entity: 'machine',
      });
    }
    if (m.vendorIds.eld) {
      rows.push({
        ref: ref(eldVendor, 'machine', m.vendorIds.eld, ''),
        entityId: m.id,
        entity: 'machine',
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// The world (farm + scenario behaviour over sim time)
// ---------------------------------------------------------------------------------------------

/** What a machine is doing at one sim instant. The stand-in turns it into vendor payloads. */
export interface SimMachineSample {
  lng: number;
  lat: number;
  /** Degrees clockwise from true north, [0, 360). */
  heading: number;
  speedMph: number;
  activity: Activity;
  engineOn: boolean;
  engineHours: number;
  odometerMi: number;
  /** 0..100 */
  fuelPct: number;
  /** SimField.id the machine is in, or null. */
  fieldId: string | null;
}

export interface SimWorld {
  readonly scenario: ScenarioName;
  readonly seed: number;
  readonly farm: SimFarm;
  /** Sim time the scenario starts at; the stand-in anchors its clock here on reset. */
  readonly startsAt: Date;
  /**
   * Sample one machine at a sim instant. Pure: same inputs, same output.
   * Returns null only for an unknown machine id or a machine with no position at that time
   * (e.g. retired). Deere-only gaps (no breadcrumbs unless working) are the Deere stand-in's
   * job, not the world's: the world always knows where a machine is.
   */
  machineAt(machineId: string, simTime: Date): SimMachineSample | null;
}

export interface CreateSimWorldOptions {
  scenario: ScenarioName;
  /** Default 1 (config SIM_SEED). */
  seed?: number;
}
/** Implemented by the sim agent in src/sim/index.ts. */
export type CreateSimWorld = (opts: CreateSimWorldOptions) => SimWorld;
/** Implemented by the sim agent in src/sim/index.ts. Depends only on the seed. */
export type BuildSimFarm = (seed?: number) => SimFarm;

// ---------------------------------------------------------------------------------------------
// The clock (owned by the stand-in process; persisted in .data/vendor-sim/state.json)
// ---------------------------------------------------------------------------------------------

export interface SimClock {
  /** Map a wall-clock instant to sim time. While paused, returns the frozen sim time. */
  wallToSim(wall: Date): Date;
  readonly paused: boolean;
  /** Sim seconds per wall second (1 = real time, 30 = a farm day in ~30 min). */
  readonly speed: number;
}

/** Serializable clock state. `simNow = paused ? anchorSim : anchorSim + (wall - anchorWall) * speed`. */
export interface SimClockState {
  /** Wall-clock ISO time of the last clock change (pause, resume, speed, jump, reset). */
  anchorWall: string;
  /** Sim ISO time at anchorWall. */
  anchorSim: string;
  speed: number;
  paused: boolean;
}

/** The normative clock arithmetic. Every clock change re-anchors at the current wall time. */
export function wallToSim(state: SimClockState, wall: Date): Date {
  const anchorSim = Date.parse(state.anchorSim);
  if (state.paused) return new Date(anchorSim);
  const elapsed = wall.getTime() - Date.parse(state.anchorWall);
  return new Date(anchorSim + elapsed * state.speed);
}

// ---------------------------------------------------------------------------------------------
// Vendor stand-in (tools/vendor-sim): one Node server, loopback only, default port 4010
// (config VENDOR_SIM_URL). Vendor APIs live under /deere, /samsara, /motive, /qbo, /nws;
// the control API under /_control. /_control/* rejects any request not from loopback (403).
// ---------------------------------------------------------------------------------------------

export const SIM_VENDORS = ['deere', 'samsara', 'motive', 'qbo', 'nws'] as const;
export type SimVendor = (typeof SIM_VENDORS)[number];

/**
 * Credentials the stand-in accepts in `sim` mode. Connectors use these when the mode is `sim`
 * and no real credential is configured. They are not secrets.
 */
export const SIM_CREDENTIALS = {
  deere: { clientId: 'sim-deere-client', clientSecret: 'sim-deere-secret' },
  samsara: { apiToken: 'sim-samsara-token' },
  motive: { apiKey: 'sim-motive-key' },
  qbo: { clientId: 'sim-qbo-client', clientSecret: 'sim-qbo-secret' },
} as const;

/** GET /_control/clock and the response of every POST /_control/clock. */
export interface SimClockStatus extends SimClockState {
  simNow: string;
  wallNow: string;
}

/** POST /_control/clock */
export type ClockControlRequest =
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'speed'; speed: number }
  /** Move sim time to `simTime` (ISO), keeping paused/speed. */
  | { action: 'jump'; simTime: string }
  /** Pause at `simTime` (what SIM_FROZEN_AT does at boot). */
  | { action: 'freeze'; simTime: string };

/** GET /_control/scenario and its POST response. */
export interface ScenarioStatus {
  scenario: ScenarioName;
  seed: number;
  startsAt: string;
}
/** POST /_control/scenario: switch scenario; re-anchors the clock at the scenario start. */
export interface ScenarioControlRequest {
  scenario: ScenarioName;
  seed?: number;
}

export const FAULT_KINDS = [
  /** Add `latencyMs` before answering. */
  'latency',
  /** Hold the request for `latencyMs` (default 60 000), then drop the socket. */
  'timeout',
  /** Answer `status` (default 500) with a vendor-shaped error body. */
  'http_error',
  /** 429 with Retry-After: `retryAfterSeconds` (default 30). */
  'rate_limit',
  /** Reject the access token as expired (401, vendor-shaped), forcing a refresh. */
  'token_expired',
  /** Reject access AND refresh tokens (re-consent needed). */
  'token_revoked',
  /** Return the previous page again (cursor does not advance). */
  'duplicate_page',
  /** Shuffle items within a page. */
  'out_of_order',
  /** Deliver each webhook twice. */
  'webhook_replay',
  /** Deliver queued webhooks in reverse order. */
  'webhook_reorder',
  /** Vendor unreachable: drop the socket immediately ("trucks API down", "internet down at 6 a.m."). */
  'outage',
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

export interface FaultRule {
  /** Unique id (the stand-in assigns one when omitted on add). */
  id: string;
  vendor: SimVendor | '*';
  /** Path prefix below the vendor root, e.g. '/fleet/vehicles/locations/feed'. Omit for all paths. */
  pathPrefix?: string;
  kind: FaultKind;
  /** 0..1, default 1. Deterministic per (rule id, request sequence number). */
  probability?: number;
  latencyMs?: number;
  status?: number;
  retryAfterSeconds?: number;
  /** Active window in WALL-clock ISO time (control API use). Omit for "now until removed". */
  from?: string;
  until?: string;
  /** Active window in SIM time (scenario schedules, e.g. bad-morning's 6 a.m. outage). */
  simFrom?: string;
  simUntil?: string;
  /** Label shown on /admin/connectors, e.g. 'trucks API down'. */
  label?: string;
}

/** POST /_control/faults. GET /_control/faults returns FaultsStatus. */
export type FaultsControlRequest =
  | { action: 'set'; rules: FaultRule[] }
  | { action: 'add'; rule: Omit<FaultRule, 'id'> & { id?: string } }
  | { action: 'remove'; id: string }
  | { action: 'clear' };
export interface FaultsStatus {
  /** Rules added through the control API. */
  rules: FaultRule[];
  /** Rules the current scenario schedules (read-only here). */
  scenarioRules: FaultRule[];
}

/** POST /_control/reset: back to a clean vendor state (tokens, cursors, webhooks, work plans). */
export interface ResetControlRequest {
  scenario?: ScenarioName;
  seed?: number;
  /** Default true. */
  clearFaults?: boolean;
  /** Default 1. */
  speed?: number;
}
/** Response of POST /_control/reset and GET /_control/status. */
export interface SimStatus {
  clock: SimClockStatus;
  scenario: ScenarioStatus;
  faults: FaultsStatus;
}
