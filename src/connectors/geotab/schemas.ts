/**
 * MyGeotab shapes (slice 1f.2, the trucks builder; docs/contracts-1f.md part B), from Geotab's
 * machine-readable reference https://my.geotab.com/api.json (ObjectModel.LogRecord,
 * ObjectModel.Engine.StatusData / FaultData / Diagnostic / FailureMode, ObjectModel.Device,
 * ObjectModel.DeviceStatusInfo, ObjectModel.FeedResult, ObjectModel.LoginResult) and
 * developers.geotab.com (Concepts, Data Feed, Rate Limits), checked Oct 30, 2026.
 *
 *   POST https://<server>/apiv1   JSON-RPC: { method, params: { …, credentials }, id? }
 *   → { result, jsonrpc: '2.0' }   or, with HTTP 200, { error: { code, message, data: { type } } }
 *
 * Errors are told apart by `error.data.type` (`InvalidUserException`, `OverLimitException` with
 * a Retry-After header, `DbUnavailableException`, `MissingMethodException`, …), never by the
 * HTTP status. References to other entities are `{ id }` objects (system ids are readable, e.g.
 * `DiagnosticEngineHoursId`, `SourceJ1939Id`, `NoFailureModeId`; other ids are opaque).
 *
 * LENIENT (§B.5): every property the reference doesn't require is optional; feed pages are
 * checked here and each item is parsed on its own by the client (a bad item is dropped and
 * logged with its id, never the page). Shared by the client, the stand-in (src/sim/vendors/
 * geotab) and the replay fixtures (./fixtures).
 */
import { z } from 'zod';

/** The KnownId Diagnostic ids the stats stream reads (everything else is dropped before landing). */
export const GEOTAB_DIAGNOSTICS = {
  /** Engine hours "provided by the ECU … as read by the GoDevice" (unit: Diagnostic.unitOfMeasure). */
  engineHours: 'DiagnosticEngineHoursId',
  /** Odometer, Raw × Odometer Factor + Odometer Offset (meters): an adjusted reading. */
  odometer: 'DiagnosticOdometerId',
  /** Fuel level, percent (GO Plan). */
  fuelLevel: 'DiagnosticFuelLevelId',
  /** Diesel exhaust fluid level (unit unconfirmed: read only when the Diagnostic says percent). */
  def: 'DiagnosticDieselExhaustFluidId',
  /** Ignition, 1 = on, 0 = off. */
  ignition: 'DiagnosticIgnitionId',
} as const;
export const GEOTAB_STAT_DIAGNOSTIC_IDS: readonly string[] = Object.values(GEOTAB_DIAGNOSTICS);

/** UnitOfMeasure ids (api.json KnownId). */
export const GEOTAB_UNITS = {
  seconds: 'UnitOfMeasureSecondsId',
  meters: 'UnitOfMeasureMetersId',
  percentage: 'UnitOfMeasurePercentageId',
  none: 'UnitOfMeasureNoneId',
} as const;

/** Source ids of a Diagnostic (the code system of a FaultData's diagnostic). */
export const GEOTAB_SOURCES = {
  j1939: 'SourceJ1939Id',
  obd: 'SourceObdId',
  obdSa: 'SourceObdSaId',
  proprietary: 'SourceProprietaryId',
} as const;

/** A FailureMode reference meaning "no FMI". */
export const GEOTAB_NO_FAILURE_MODE = 'NoFailureModeId';

const iso = z.iso.datetime({ offset: true });
const text = z.string().nullish();

/** An entity reference: `{ id }` (a bare id string is read the same way). */
export const geotabRefSchema = z
  .union([z.string().min(1), z.looseObject({ id: z.string().min(1) })])
  .transform((v) => (typeof v === 'string' ? { id: v } : v));
export type GeotabRef = z.infer<typeof geotabRefSchema>;

// ---- JSON-RPC envelope ------------------------------------------------------------------------

export const geotabRpcErrorSchema = z.looseObject({
  code: z.number().optional(),
  message: z.string().optional(),
  data: z
    .looseObject({
      id: z.string().optional(),
      type: z.string().optional(),
      requestIndex: z.number().optional(),
    })
    .optional(),
});
export type GeotabRpcError = z.infer<typeof geotabRpcErrorSchema>;

export const geotabRpcResponseSchema = z.looseObject({
  result: z.unknown().optional(),
  error: geotabRpcErrorSchema.optional(),
  jsonrpc: z.string().optional(),
  id: z.unknown().optional(),
});

/** Authenticate → LoginResult. `path` is "ThisServer", a server name, or absent (deprecated). */
export const geotabLoginResultSchema = z.looseObject({
  credentials: z.looseObject({
    database: z.string().min(1),
    userName: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  path: z.string().nullish(),
});
export type GeotabLoginResult = z.infer<typeof geotabLoginResultSchema>;

/** GetFeed → FeedResult: `toVersion` is the next `fromVersion` (one counter per entity type). */
export const geotabFeedResultSchema = z.looseObject({
  data: z.array(z.unknown()),
  toVersion: z.string().nullish(),
});
export type GeotabFeedResult = z.infer<typeof geotabFeedResultSchema>;

/** Get → an array of entities. */
export const geotabGetResultSchema = z.array(z.unknown());

// ---- Entities ---------------------------------------------------------------------------------

/** A GPS log (positions). `speed` is km/h ("the logged speed or an invalid speed"); no heading. */
export const geotabLogRecordSchema = z.looseObject({
  id: text,
  dateTime: iso,
  device: geotabRefSchema,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  speed: z.number().nullish(),
});
export type GeotabLogRecord = z.infer<typeof geotabLogRecordSchema>;

/** One diagnostic reading (stats). `data` is in the diagnostic's own unit. */
export const geotabStatusDataSchema = z.looseObject({
  id: text,
  version: text,
  dateTime: iso,
  device: geotabRefSchema,
  diagnostic: geotabRefSchema,
  data: z.number(),
});
export type GeotabStatusData = z.infer<typeof geotabStatusDataSchema>;

/** One fault record (an "active data" feed: each record is an occurrence or a state change). */
export const geotabFaultDataSchema = z.looseObject({
  id: z.string().min(1),
  dateTime: iso,
  device: geotabRefSchema,
  diagnostic: geotabRefSchema.nullish(),
  failureMode: geotabRefSchema.nullish(),
  controller: geotabRefSchema.nullish(),
  count: z.number().int().nullish(),
  /** None | Pending | Active | Inactive | Cleared (deprecated in favour of faultStates). */
  faultState: text,
  /** None | Malfunction | Warning | Stop | Protect (J1939). */
  faultLampState: text,
  malfunctionLamp: z.boolean().nullish(),
  amberWarningLamp: z.boolean().nullish(),
  redStopLamp: z.boolean().nullish(),
  protectWarningLamp: z.boolean().nullish(),
  /** DtcSeverity: MaintenanceOnly | CheckAtNextHalt | CheckImmediately | NoRepairNeeded. */
  severity: text,
  sourceAddress: z.number().int().nullish(),
  faultDescription: text,
  dismissDateTime: iso.nullish(),
});
export type GeotabFaultData = z.infer<typeof geotabFaultDataSchema>;

export const geotabDiagnosticSchema = z.looseObject({
  id: z.string().min(1),
  name: text,
  /** The diagnostic code: the SPN for a J1939 source, the DTC number for OBD-II. */
  code: z.number().int().nullish(),
  source: geotabRefSchema.nullish(),
  controller: geotabRefSchema.nullish(),
  unitOfMeasure: geotabRefSchema.nullish(),
  diagnosticType: text,
});
export type GeotabDiagnostic = z.infer<typeof geotabDiagnosticSchema>;

/** A FailureMode: `code` is the J1939 FMI. */
export const geotabFailureModeSchema = z.looseObject({
  id: z.string().min(1),
  code: z.number().int().nullish(),
  name: text,
});
export type GeotabFailureMode = z.infer<typeof geotabFailureModeSchema>;

export const geotabDeviceSchema = z.looseObject({
  id: z.string().min(1),
  name: text,
  serialNumber: text,
  deviceType: text,
  vehicleIdentificationNumber: text,
  groups: z.array(geotabRefSchema).nullish(),
  activeFrom: iso.nullish(),
  activeTo: iso.nullish(),
});
export type GeotabDevice = z.infer<typeof geotabDeviceSchema>;

export const geotabGroupSchema = z.looseObject({ id: z.string().min(1), name: text });
export type GeotabGroup = z.infer<typeof geotabGroupSchema>;

/** The latest known state of a device (the limited-scope fallback; Get DeviceStatusInfo). */
export const geotabDeviceStatusInfoSchema = z.looseObject({
  device: geotabRefSchema,
  dateTime: iso,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Integer degrees. */
  bearing: z.number().nullish(),
  /** km/h. */
  speed: z.number().nullish(),
  isDeviceCommunicating: z.boolean().nullish(),
  /** With `search.diagnostics` (beta): the latest StatusData of those diagnostics. */
  statusData: z.array(z.unknown()).nullish(),
});
export type GeotabDeviceStatusInfo = z.infer<typeof geotabDeviceStatusInfoSchema>;

// ---- Raw items (what lands in ingest.raw_events) ----------------------------------------------

/**
 * Stream 'positions': a LogRecord (a live trail point) or, for a limited-scope user, the
 * device's DeviceStatusInfo (its last known position). externalId `${device}:${dateTime}`.
 */
export const geotabPositionRawSchema = z.discriminatedUnion('entity', [
  z.object({ entity: z.literal('LogRecord'), record: geotabLogRecordSchema }),
  z.object({ entity: z.literal('DeviceStatusInfo'), record: geotabDeviceStatusInfoSchema }),
]);
export type GeotabPositionRaw = z.infer<typeof geotabPositionRawSchema>;

/** Stream 'stats': one StatusData of our diagnostics, with that diagnostic's unit. */
export const geotabStatRawSchema = z.object({
  record: geotabStatusDataSchema,
  diagnostic: geotabDiagnosticSchema.nullable(),
});
export type GeotabStatRaw = z.infer<typeof geotabStatRawSchema>;

/** Stream 'faults': one FaultData with its Diagnostic and FailureMode looked up. */
export const geotabFaultRawSchema = z.object({
  record: geotabFaultDataSchema,
  diagnostic: geotabDiagnosticSchema.nullable(),
  failureMode: geotabFailureModeSchema.nullable(),
});
export type GeotabFaultRaw = z.infer<typeof geotabFaultRawSchema>;

/** Stream 'vehicles': one Device with the names of its groups. */
export const geotabVehicleRawSchema = z.object({
  device: geotabDeviceSchema,
  groups: z.array(z.string()),
});
export type GeotabVehicleRaw = z.infer<typeof geotabVehicleRawSchema>;
