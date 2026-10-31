/**
 * Fleet contract: what the board and phones receive on the realtime topic `fleet`
 * (event `tick`) and from the fleet snapshot endpoint (GET /api/fleet).
 *
 * One `tick` per sync run carries every machine (batched, plan §1). Keep it under the
 * ~8 KB pg_notify limit: `publish()` downgrades an oversized payload to an `invalidate`
 * event and clients refetch the snapshot.
 *
 * Pure TS + zod. Owned by the foundation stage; changes go through the stage report.
 */
import { z } from 'zod';

export const MACHINE_KINDS = [
  'combine',
  'tractor',
  'sprayer',
  'planter',
  'grain_cart',
  'semi',
  'trailer',
  'drone',
  'pickup',
  // 1f.2 (docs/contracts-1f.md part B): not every telematics vehicle is a semi, and the yard has
  // loaders (the demo's Kubota on AEMP).
  'service_truck',
  'loader',
] as const;
export type MachineKind = (typeof MACHINE_KINDS)[number];

export const MACHINE_STATUSES = ['active', 'down', 'retired'] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

/** `queued` = waiting in line at an elevator (inside its geofence, slow or stopped). */
export const ACTIVITIES = ['working', 'transport', 'idle', 'queued'] as const;
export type Activity = (typeof ACTIVITIES)[number];

/**
 * Which kind of feed produced the latest fix (the board shows it as a badge). `eld` is any
 * vehicle telematics device that reports continuously (an ELD, a GPS tracker, an asset gateway,
 * a carmaker cloud, an OEM telematics feed): the value predates the vendor-neutral port (1f.2)
 * and stays for the database CHECK; its badge reads "Telematics" where it isn't a truck ELD.
 */
export const POSITION_SOURCES = ['eld', 'deere_working', 'cab_device', 'manual'] as const;
export type PositionSource = (typeof POSITION_SOURCES)[number];

/**
 * 1f.2: a `live` fix is a point of the machine's trail (farm.positions + machine_state); a
 * `last_known` fix is a vendor snapshot of where the machine was last seen (AEMP / ISO 15143-3
 * hourly snapshots, Terminal's latest location): it updates machine_state only (when newer),
 * never farm.positions, never geofence visits, and goes stale on its own, longer threshold.
 */
export const POSITION_KINDS = ['live', 'last_known'] as const;
export type PositionKind = (typeof POSITION_KINDS)[number];

/**
 * The connector a fix came from (machine_state.position_vendor; the fleet panel's
 * "Samsara · sim" badge). Since 1f.2 any id of this format (no migration per vendor): a registry
 * id from src/connectors/vendors.ts (`samsara`, `motive`, `geotab`, `deere`, `cnh`, `terminal`,
 * `aemp`) or `<route>_<provider>` for an aggregator route (`aemp_kubota`, `terminal_omnitracs`).
 * The panel labels it with `vendorLabel()` and falls back to the raw id. Null = a manual fix or
 * a row older than 0007. The database CHECKs the same pattern.
 */
export const POSITION_VENDOR_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;
/** The same pattern as SQL (machine_state_position_vendor_check, machines_telematics_via_check). */
export const POSITION_VENDOR_SQL_PATTERN = '^[a-z][a-z0-9_]{1,30}$';
export type PositionVendor = string;
export const positionVendorSchema = z.string().regex(POSITION_VENDOR_PATTERN);
export function isPositionVendor(v: unknown): v is PositionVendor {
  return typeof v === 'string' && POSITION_VENDOR_PATTERN.test(v);
}

/**
 * The position_vendor id of a fix: the connector source, or `<source>_<provider>` when an
 * aggregator route names the provider behind it (AEMP providers, Terminal's providers).
 */
export function positionVendorId(source: string, provider?: string | null): PositionVendor {
  const id = provider ? `${source}_${provider.toLowerCase().replace(/[^a-z0-9_]/g, '_')}` : source;
  const out = id.slice(0, 31);
  if (!POSITION_VENDOR_PATTERN.test(out)) throw new Error(`positionVendorId: bad id '${id}'`);
  return out;
}

/** A machine older than this (wall clock) is `stale` (plan 1a: 10 min). Config: FLEET_STALE_SECONDS. */
export const DEFAULT_STALE_AFTER_SECONDS = 600;
/**
 * A `last_known` fix (AEMP hourly snapshots, cached up to an hour by the OEM) is stale after
 * this (1f.2; config FLEET_STALE_SECONDS_LAST_KNOWN): 3 h, so one missed snapshot isn't an alarm.
 */
export const DEFAULT_LAST_KNOWN_STALE_AFTER_SECONDS = 10_800;

/** One machine as the map draws it. */
export interface MachineView {
  /** farm.machines.id (uuid). */
  id: string;
  /** Unit number painted on the machine, e.g. "C1", "S3". */
  unitNo: string;
  kind: MachineKind;
  /** WGS84 longitude of the latest fix. */
  lng: number;
  /** WGS84 latitude of the latest fix. */
  lat: number;
  /** Degrees clockwise from true north, [0, 360). 0 when unknown. */
  heading: number;
  /** Ground speed in mph, >= 0. */
  speedMph: number;
  activity: Activity;
  /** farm.fields.id the machine is in, or null (road, yard, elevator). */
  fieldId: string | null;
  positionSource: PositionSource;
  /**
   * 1f.2: `last_known` = a vendor snapshot, not a trail point (the marker says "last known");
   * absent = `live` (every M0/M1 fix).
   */
  positionKind?: PositionKind;
  /** Wall-clock UTC ISO-8601 time of the latest fix (also in sim mode). */
  ts: string;
  status: MachineStatus;
  /** True when `ts` is older than the stale threshold at the time the tick was built. */
  stale: boolean;
}

/** Payload of realtime event `fleet` / `tick`, and the body of GET /api/fleet. */
export interface FleetTick {
  /** Wall-clock UTC ISO-8601 time the tick was built. */
  ts: string;
  machines: MachineView[];
}

export const machineViewSchema = z.object({
  id: z.uuid(),
  unitNo: z.string().min(1),
  kind: z.enum(MACHINE_KINDS),
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  heading: z.number().min(0).lt(360),
  speedMph: z.number().min(0),
  activity: z.enum(ACTIVITIES),
  fieldId: z.uuid().nullable(),
  positionSource: z.enum(POSITION_SOURCES),
  positionKind: z.enum(POSITION_KINDS).optional(),
  ts: z.iso.datetime({ offset: true }),
  status: z.enum(MACHINE_STATUSES),
  stale: z.boolean(),
}) satisfies z.ZodType<MachineView>;

export const fleetTickSchema = z.object({
  ts: z.iso.datetime({ offset: true }),
  machines: z.array(machineViewSchema),
}) satisfies z.ZodType<FleetTick>;

/** Is a fix at `ts` stale at wall-clock `now`? */
export function isStale(
  ts: string | Date,
  now: Date,
  staleAfterSeconds: number = DEFAULT_STALE_AFTER_SECONDS,
): boolean {
  const t = typeof ts === 'string' ? Date.parse(ts) : ts.getTime();
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > staleAfterSeconds * 1000;
}

/**
 * Stale thresholds by where a fix came from. ELD, cab-device and manual positions arrive
 * continuously, so a gap means trouble (`staleAfterSeconds` = FLEET_STALE_SECONDS). Deere records
 * positions only while a machine works, so an idle cart or a combine waiting on a truck has no new
 * fix for minutes at a time; `deereStaleAfterSeconds` (FLEET_STALE_SECONDS_DEERE) is its own limit.
 */
export interface StaleThresholds {
  staleAfterSeconds: number;
  deereStaleAfterSeconds: number;
  /**
   * 1f.2: for `last_known` fixes (FLEET_STALE_SECONDS_LAST_KNOWN). Absent =
   * DEFAULT_LAST_KNOWN_STALE_AFTER_SECONDS, but never below the other two.
   */
  lastKnownStaleAfterSeconds?: number;
}

/** Thresholds from one number (all the same) or a set. */
export function staleThresholds(t: number | StaleThresholds): StaleThresholds {
  return typeof t === 'number'
    ? { staleAfterSeconds: t, deereStaleAfterSeconds: t, lastKnownStaleAfterSeconds: t }
    : t;
}

/** The stale threshold for a fix from `source` (and of `kind`; default live). */
export function staleAfterFor(
  source: PositionSource,
  t: number | StaleThresholds,
  kind: PositionKind = 'live',
): number {
  const th = staleThresholds(t);
  if (kind === 'last_known') {
    return (
      th.lastKnownStaleAfterSeconds ??
      Math.max(
        DEFAULT_LAST_KNOWN_STALE_AFTER_SECONDS,
        th.staleAfterSeconds,
        th.deereStaleAfterSeconds,
      )
    );
  }
  return source === 'deere_working' ? th.deereStaleAfterSeconds : th.staleAfterSeconds;
}

/** Is this machine's latest fix stale at wall-clock `now` (threshold by its source and kind)? */
export function isMachineStale(
  m: Pick<MachineView, 'ts' | 'positionSource' | 'positionKind'>,
  now: Date,
  t: number | StaleThresholds,
): boolean {
  return isStale(m.ts, now, staleAfterFor(m.positionSource, t, m.positionKind ?? 'live'));
}

/**
 * How long without a new Deere breadcrumb before a working-only machine reads "Last working
 * position" (fleet.deere polls every 2 min and Deere's breadcrumbs arrive a minute or two late, so
 * 3 min of silence means it stopped working; docs/contracts-1f.md §5.3).
 */
export const DEERE_STOPPED_WORKING_SECONDS = 180;

/** The stopped-working threshold for these stale thresholds (never past the Deere stale one). */
export function deereStoppedWorkingSeconds(t: number | StaleThresholds): number {
  return Math.min(DEERE_STOPPED_WORKING_SECONDS, staleThresholds(t).deereStaleAfterSeconds);
}

/**
 * A Deere working-only machine (breadcrumbs only while it works) whose last breadcrumb is older
 * than `deereStoppedWorkingSeconds`: it stopped working, so the panel, the map and the board card
 * show its last working position instead of a stale alarm (§5.3). Never stale while this holds.
 */
export function isLastWorking(
  m: Pick<MachineView, 'ts' | 'positionSource' | 'positionKind'>,
  now: Date,
  t: number | StaleThresholds,
): boolean {
  return (
    m.positionSource === 'deere_working' &&
    (m.positionKind ?? 'live') !== 'last_known' &&
    now.getTime() - Date.parse(m.ts) >= deereStoppedWorkingSeconds(t) * 1000
  );
}

/** Normalize any heading to [0, 360). */
export function normalizeHeading(deg: number | null | undefined): number {
  if (deg == null || !Number.isFinite(deg)) return 0;
  const h = deg % 360;
  return h < 0 ? h + 360 : h;
}
