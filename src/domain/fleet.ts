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
] as const;
export type MachineKind = (typeof MACHINE_KINDS)[number];

export const MACHINE_STATUSES = ['active', 'down', 'retired'] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

/** `queued` = waiting in line at an elevator (inside its geofence, slow or stopped). */
export const ACTIVITIES = ['working', 'transport', 'idle', 'queued'] as const;
export type Activity = (typeof ACTIVITIES)[number];

/** Which feed produced the latest fix (the board shows it as a badge). */
export const POSITION_SOURCES = ['eld', 'deere_working', 'cab_device', 'manual'] as const;
export type PositionSource = (typeof POSITION_SOURCES)[number];

/** A machine older than this (wall clock) is `stale` (plan 1a: 10 min). Config: FLEET_STALE_SECONDS. */
export const DEFAULT_STALE_AFTER_SECONDS = 600;

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
}

/** Thresholds from one number (both the same) or a pair. */
export function staleThresholds(t: number | StaleThresholds): StaleThresholds {
  return typeof t === 'number' ? { staleAfterSeconds: t, deereStaleAfterSeconds: t } : t;
}

/** The stale threshold for a fix from `source`. */
export function staleAfterFor(source: PositionSource, t: number | StaleThresholds): number {
  const th = staleThresholds(t);
  return source === 'deere_working' ? th.deereStaleAfterSeconds : th.staleAfterSeconds;
}

/** Is this machine's latest fix stale at wall-clock `now` (threshold by its position source)? */
export function isMachineStale(
  m: Pick<MachineView, 'ts' | 'positionSource'>,
  now: Date,
  t: number | StaleThresholds,
): boolean {
  return isStale(m.ts, now, staleAfterFor(m.positionSource, t));
}

/** Normalize any heading to [0, 360). */
export function normalizeHeading(deg: number | null | undefined): number {
  if (deg == null || !Number.isFinite(deg)) return 0;
  const h = deg % 360;
  return h < 0 ? h + 360 : h;
}
