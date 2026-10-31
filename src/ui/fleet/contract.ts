/**
 * The fleet panel's API (pure TS + zod; the routes, the queries and the browser share it):
 *
 *   GET  /api/machines              -> FleetPanelData: every machine that isn't retired, with
 *                                      its latest fix (or none yet), down state and the geofence
 *                                      it is in; viewer and up.
 *   POST /api/machines/<id>/status  <- SetMachineStatusBody: mark a machine down with a reason,
 *                                      or back up (ROLE_FOR.markMachineDown); -> MachineStatusResult.
 *
 * After a change the server publishes `fleet`/`machine` (MachineStatusPayload) and, in the same
 * transaction, `fleet`/`invalidate` { event: 'machine', reason: 'changed' } (contracts-m1 §6).
 *
 * 1f (docs/contracts-1f.md §5.3, fleet-faults): each machine may carry its active fault codes
 * (`faults`, worst first; a change publishes `fleet`/`invalidate` { event: 'machine', reason:
 * 'faults' }), its position the connector it came from (`position.vendor`, for the
 * "Samsara · sim" badge with `modes`), and its engine hours, odometer and fuel. All optional so
 * the 1a code keeps compiling; absent = none known.
 *
 * 1f.2 (part B): `modes` has one entry per connection (src/connectors/vendors.ts CONNECTIONS);
 * `position.vendor` is any vendor id (labelled by `vendorLabel`), `position.positionKind` says
 * live or last-known; a machine says how its vendor gets the data (`via`) and which stats its
 * route doesn't report (`notReported`: shown as "not reported", never 0).
 */
import { z } from 'zod';
import { CONNECTOR_MODES, VEHICLE_STAT_FIELDS } from '../../connectors/types';
import { CONNECTIONS, type Connection } from '../../connectors/vendors';
import { GEOFENCE_KINDS } from '../../domain/farm';
import { activeFaultCodeSchema } from '../../domain/fault-codes';
import {
  ACTIVITIES,
  MACHINE_KINDS,
  MACHINE_STATUSES,
  POSITION_KINDS,
  POSITION_SOURCES,
  positionVendorSchema,
} from '../../domain/fleet';
import { KIND_SET_BY, telematicsViaSchema } from '../../domain/vehicles';

export const MACHINES_URL = '/api/machines';
export const machineStatusUrl = (id: string) => `${MACHINES_URL}/${encodeURIComponent(id)}/status`;

/** Longest down reason kept (the phone sheet counts down to it). */
export const MAX_DOWN_REASON_CHARS = 200;

/** One-tap reasons on the phone sheet; anything else goes in the text box. */
export const QUICK_DOWN_REASONS = [
  'Breakdown',
  'Flat tire',
  'Hydraulic leak',
  'Electrical',
  'Engine',
  'Scheduled service',
] as const;

const iso = z.iso.datetime({ offset: true });

export const panelPositionSchema = z.object({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  heading: z.number().min(0).lt(360),
  speedMph: z.number().min(0),
  activity: z.enum(ACTIVITIES),
  positionSource: z.enum(POSITION_SOURCES),
  /** Wall-clock UTC time of the fix. */
  ts: iso,
  fieldId: z.uuid().nullable(),
  fieldName: z.string().nullable(),
  /**
   * 1f: the vendor the fix came from (machine_state.position_vendor; 1f.2: any vendor id, e.g.
   * `samsara`, `aemp_kubota`, labelled by `vendorLabel`); null = manual/unknown.
   */
  vendor: positionVendorSchema.nullable().optional(),
  /** 1f.2: a trail point (live) or a vendor snapshot (last_known); absent = live. */
  positionKind: z.enum(POSITION_KINDS).optional(),
});
export type PanelPosition = z.infer<typeof panelPositionSchema>;

/** The geofence the machine is in right now (its open farm.geofence_visits row). */
export const panelPlaceSchema = z.object({
  geofenceId: z.uuid(),
  name: z.string(),
  kind: z.enum(GEOFENCE_KINDS),
  since: iso,
});
export type PanelPlace = z.infer<typeof panelPlaceSchema>;

export const panelMachineSchema = z.object({
  id: z.uuid(),
  unitNo: z.string().min(1),
  kind: z.enum(MACHINE_KINDS),
  make: z.string().nullable(),
  model: z.string().nullable(),
  status: z.enum(MACHINE_STATUSES),
  downReason: z.string().nullable(),
  downAt: iso.nullable(),
  /** Who marked it down (display name), when known. */
  downBy: z.string().nullable(),
  /** Null until the first fix arrives. */
  position: panelPositionSchema.nullable(),
  place: panelPlaceSchema.nullable(),
  /**
   * 1f: active fault codes (machine_state.fault_codes), worst first. A critical one offers
   * "Critical fault: mark down?" to `canMarkDown` sessions (decision 2; never automatic).
   */
  faults: z.array(activeFaultCodeSchema).optional(),
  /**
   * 1f: the hour meter (machines.engine_hours: the greatest reading any connector reported, Deere
   * engine hours or Samsara stats; never decreasing). Null = none known.
   */
  engineHours: z.number().nullable().optional(),
  /** 1f: the odometer in miles (machines.odometer_mi, never decreasing). Null = none known. */
  odometerMi: z.number().nullable().optional(),
  /** 1f: fuel level, percent 0-100 (machine_state.fuel_pct, time-guarded by stats_at). Null = none known. */
  fuelPct: z.number().nullable().optional(),
  /** 1f.2: diesel exhaust fluid, percent 0-100 (machine_state.def_pct, guarded like fuel). Null = none known. */
  defPct: z.number().nullable().optional(),
  /** 1f.2: the route reports no fault system (`faultsNotReported`): "faults not reported", not a clean bill. */
  faultsNotReported: z.boolean().optional(),
  /** 1f.2: how its vendor gets the data (machines.telematics_via: ford_pro, stellantis, gateway). */
  via: telematicsViaSchema.nullable().optional(),
  /** 1f.2: who set `kind` (a kind set on /admin wins over vendor tags). */
  kindSetBy: z.enum(KIND_SET_BY).optional(),
  /**
   * 1f.2: stats this machine's route doesn't report (`statsNotReported(position vendor, via)`):
   * a null value among them reads "not reported", never 0 or "unknown".
   */
  notReported: z.array(z.enum(VEHICLE_STAT_FIELDS)).optional(),
});
export type PanelMachine = z.infer<typeof panelMachineSchema>;

const connectorMode = z.enum(CONNECTOR_MODES);

/** One mode per connection (1f.2): `{ deere, samsara, motive, geotab, aemp, cnh, terminal }`. */
export const panelModesSchema = z.object(
  Object.fromEntries(CONNECTIONS.map((c) => [c, connectorMode])) as Record<
    Connection,
    typeof connectorMode
  >,
);
export type PanelModes = z.infer<typeof panelModesSchema>;

export const fleetPanelDataSchema = z.object({
  builtAt: iso,
  machines: z.array(panelMachineSchema),
  /** The session may mark machines down / up (the server checks again on every POST). */
  canMarkDown: z.boolean(),
  /**
   * Where the positions come from (the panel says "replay" so nobody mistakes it for live):
   * one mode per connection since 1f.2.
   */
  modes: panelModesSchema,
  /** What the browser needs to follow the fleet live. */
  config: z.object({
    appEnv: z.enum(['development', 'test', 'production']),
    realtime: z.enum(['sse', 'supabase']),
    staleAfterSeconds: z.number().int().positive(),
    deereStaleAfterSeconds: z.number().int().positive(),
    /** 1f.2: FLEET_STALE_SECONDS_LAST_KNOWN (vendor snapshots). */
    lastKnownStaleAfterSeconds: z.number().int().positive().optional(),
  }),
});
export type FleetPanelData = z.infer<typeof fleetPanelDataSchema>;

export const setMachineStatusBodySchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('down'),
    reason: z
      .string()
      .trim()
      .min(1, 'say why it is down')
      .max(MAX_DOWN_REASON_CHARS, `keep the reason under ${MAX_DOWN_REASON_CHARS} characters`),
  }),
  z.strictObject({ status: z.literal('active') }),
]);
export type SetMachineStatusBody = z.infer<typeof setMachineStatusBodySchema>;

export const machineStatusResultSchema = z.object({
  machineId: z.uuid(),
  status: z.enum(MACHINE_STATUSES),
  downReason: z.string().nullable(),
  downAt: iso.nullable(),
  by: z.string().nullable(),
});
export type MachineStatusResult = z.infer<typeof machineStatusResultSchema>;
