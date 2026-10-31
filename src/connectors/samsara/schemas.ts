/**
 * Samsara API shapes (zod), shared by the live client (src/connectors/samsara/client.ts) and the
 * vendor stand-in (src/sim/vendors/samsara), so the same schemas validate real and simulated
 * responses (plan §5).
 *
 * Source: Samsara's public API reference as published in its official SDK
 * (@samsarahq/samsara 14.11, types VehicleLocationsListResponse, VehicleLocation,
 * PaginationResponse, VehicleStatsListResponse, *ErrorResponseBody), checked Oct 29, 2026, and
 * Samsara's OpenAPI 3.0.1 spec (developers.samsara.com/openapi/samsara-api.json, Oct 30):
 *   GET https://api.samsara.com/fleet/vehicles/locations/feed?after=&vehicleIds=&tagIds=
 *   GET https://api.samsara.com/fleet/vehicles/stats/feed?types=a,b,c&after=   (at most 3 types)
 *   GET https://api.samsara.com/fleet/vehicles/stats/feed?types=faultCodes&after=   (slice 1f)
 *   Authorization: Bearer <API token>
 * Objects are `loose` so fields we don't use (decorations, address book entries) never fail a
 * real response; we validate what we read.
 */
import { z } from 'zod';

/** RFC 3339 UTC timestamp, e.g. `2020-01-27T07:06:25Z` (fractions allowed). */
const time = z.iso.datetime({ offset: true });

export const samsaraPaginationSchema = z.looseObject({
  /** Cursor for the next request's `after`. May be '' when no more pages are left (history endpoints). */
  endCursor: z.string(),
  /** True when more results are immediately available after endCursor. */
  hasNextPage: z.boolean(),
});
export type SamsaraPagination = z.infer<typeof samsaraPaginationSchema>;

/** One location event of a vehicle (VehicleLocation). */
export const samsaraLocationSchema = z.looseObject({
  time,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Degrees. */
  heading: z.number().optional(),
  /**
   * GPS speed in miles per hour. (`isEcuSpeed` is a field of the stats feed's `gps` object only,
   * not of VehicleLocation: Samsara's spec; a loose object ignores it if it ever appears.)
   */
  speed: z.number().optional(),
  reverseGeo: z.looseObject({ formattedLocation: z.string().optional() }).optional(),
});
export type SamsaraLocation = z.infer<typeof samsaraLocationSchema>;

/** A vehicle and its location events (VehicleLocationsListResponseData). */
export const samsaraVehicleLocationsSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  locations: z.array(samsaraLocationSchema),
});
export type SamsaraVehicleLocations = z.infer<typeof samsaraVehicleLocationsSchema>;

/** GET /fleet/vehicles/locations/feed (VehicleLocationsListResponse). */
export const samsaraLocationsFeedSchema = z.looseObject({
  data: z.array(samsaraVehicleLocationsSchema),
  pagination: samsaraPaginationSchema,
});
export type SamsaraLocationsFeed = z.infer<typeof samsaraLocationsFeedSchema>;

/** `{ time, value }` stat event (VehicleStatsFuelPercent, VehicleStatsObdOdometerMeters, …). */
export const samsaraStatValueSchema = z.looseObject({ time, value: z.number() });
export type SamsaraStatValue = z.infer<typeof samsaraStatValueSchema>;

/** Stat types this app reads from the stats feed (Samsara allows at most 3 per request). */
export const SAMSARA_STAT_TYPES = [
  'obdEngineSeconds',
  'fuelPercents',
  'obdOdometerMeters',
] as const;
export type SamsaraStatType = (typeof SAMSARA_STAT_TYPES)[number];

/** A vehicle and its stat events (VehicleStatsListResponseData, the subset we read). */
export const samsaraVehicleStatsSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  obdEngineSeconds: z.array(samsaraStatValueSchema).optional(),
  fuelPercents: z.array(samsaraStatValueSchema).optional(),
  obdOdometerMeters: z.array(samsaraStatValueSchema).optional(),
});
export type SamsaraVehicleStats = z.infer<typeof samsaraVehicleStatsSchema>;

/** GET /fleet/vehicles/stats/feed (VehicleStatsListResponse). */
export const samsaraStatsFeedSchema = z.looseObject({
  data: z.array(samsaraVehicleStatsSchema),
  pagination: samsaraPaginationSchema,
});
export type SamsaraStatsFeed = z.infer<typeof samsaraStatsFeedSchema>;

// ---------------------------------------------------------------------------------------------
// faultCodes (slice 1f, fleet-faults): GET /fleet/vehicles/stats/feed?types=faultCodes. Its own
// call (and so its own cursor: a Samsara cursor belongs to its `types` set): the three stat
// types above already fill the 3-types limit. Shapes from Samsara's OpenAPI
// (VehicleStatsFaultCodesWithDecoration and its J1939 / OBD-II / OEM children) and the Fault
// Monitoring guide (developers.samsara.com/docs/fault-monitoring). The spec marks most fields
// required; we require only what a fault's identity needs (SPN + FMI, a DTC, an OEM code
// identifier), so a reading with an odd field never fails the page (a reading that can't be
// read fails its own raw event, which the sync step retries and then dead-letters).
// ---------------------------------------------------------------------------------------------

/** The stats type the faults stream asks for (alone: one cursor per types set). */
export const SAMSARA_FAULT_TYPE = 'faultCodes' as const;

/** The reading's J1939 lamps (`checkEngineLights`): they cover the whole reading, not one code. */
export const samsaraJ1939LampsSchema = z.looseObject({
  /** Red stop lamp. */
  stopIsOn: z.boolean().optional(),
  /** Amber warning lamp. */
  warningIsOn: z.boolean().optional(),
  /** Engine protect lamp. */
  protectIsOn: z.boolean().optional(),
  /** Emissions (MIL) lamp: "MIL status is nonzero". */
  emissionsIsOn: z.boolean().optional(),
});

/** One active J1939 DM1 code. */
export const samsaraJ1939DtcSchema = z.looseObject({
  spnId: z.number().int().min(0).max(524_287),
  fmiId: z.number().int().min(0).max(31),
  /** The transmitting controller's source address (0 = Engine #1). */
  txId: z.number().int().optional(),
  milStatus: z.number().int().optional(),
  occurrenceCount: z.number().int().min(0).optional(),
  spnDescription: z.string().optional(),
  fmiDescription: z.string().optional(),
  sourceAddressName: z.string().optional(),
  vendorSpecificFields: z
    .looseObject({
      dtcDescription: z.string().optional(),
      repairInstructionsUrl: z.string().optional(),
    })
    .optional(),
});

/** An OBD-II DTC as Samsara lists it (`dtcShortCode` 'P0087'; `dtcId` the J2012 number, 135). */
export const samsaraObdDtcSchema = z.looseObject({
  dtcId: z.number().int().min(0).max(0xffff),
  dtcShortCode: z.string().optional(),
  dtcDescription: z.string().optional(),
});

/** One OBD-II control module's report (`txId`, e.g. 2024 = 0x7E8, the engine controller). */
export const samsaraObdModuleSchema = z.looseObject({
  txId: z.number().int(),
  milStatus: z.boolean().optional(),
  ignitionType: z.string().optional(),
  confirmedDtcs: z.array(samsaraObdDtcSchema).optional(),
  pendingDtcs: z.array(samsaraObdDtcSchema).optional(),
  permanentDtcs: z.array(samsaraObdDtcSchema).optional(),
});

/** A proprietary code of an OEM-integrated vehicle (`oem.diagnosticTroubleCodes[]`). */
export const samsaraOemDtcSchema = z.looseObject({
  codeIdentifier: z.string().optional(),
  codeDescription: z.string().optional(),
  /** Free text, e.g. 'L03' (meaning undocumented: kept verbatim as the vendor's severity). */
  codeSeverity: z.string().optional(),
  codeSource: z.string().optional(),
});

/** One faultCodes reading: the vehicle's active codes at `time`. */
export const samsaraFaultCodesReadingSchema = z.looseObject({
  time,
  canBusType: z.string().optional(),
  j1939: z
    .looseObject({
      checkEngineLights: samsaraJ1939LampsSchema.optional(),
      /** "Empty if there are no active fault codes." */
      diagnosticTroubleCodes: z.array(samsaraJ1939DtcSchema).optional(),
    })
    .optional(),
  obdii: z
    .looseObject({
      checkEngineLightIsOn: z.boolean().optional(),
      /** One entry per control module that reported. */
      diagnosticTroubleCodes: z.array(samsaraObdModuleSchema).optional(),
    })
    .optional(),
  oem: z
    .looseObject({
      diagnosticTroubleCodes: z.array(samsaraOemDtcSchema).optional(),
    })
    .optional(),
});
export type SamsaraFaultCodesReading = z.infer<typeof samsaraFaultCodesReadingSchema>;

/**
 * GET /fleet/vehicles/stats/feed?types=faultCodes. Each reading is checked only for its time
 * here (it names the raw item); the mapper validates it in full, so one bad reading fails its
 * own raw event, never the page.
 */
export const samsaraFaultCodesFeedSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string().min(1),
      name: z.string().optional(),
      faultCodes: z.array(z.looseObject({ time })).optional(),
    }),
  ),
  pagination: samsaraPaginationSchema,
});
export type SamsaraFaultCodesFeed = z.infer<typeof samsaraFaultCodesFeedSchema>;

/** Error body of every endpoint (`*ErrorResponseBody`: message + requestId). */
export const samsaraErrorSchema = z.looseObject({
  message: z.string(),
  requestId: z.string().optional(),
});
export type SamsaraError = z.infer<typeof samsaraErrorSchema>;

// ---------------------------------------------------------------------------------------------
// Raw items as landed in ingest.raw_events (one location / stat event per row, so a duplicate
// page dedupes on sha256 and an out-of-order page can't create duplicate positions).
// ---------------------------------------------------------------------------------------------

/** stream 'positions': one vehicle + ONE location event. externalId `${id}:${time}`. */
export const samsaraPositionRawSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  location: samsaraLocationSchema,
});
export type SamsaraPositionRaw = z.infer<typeof samsaraPositionRawSchema>;

/** stream 'stats': one vehicle + ONE stat event of one type. externalId `${id}:${type}:${time}`. */
export const samsaraStatRawSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  type: z.enum(SAMSARA_STAT_TYPES),
  stat: samsaraStatValueSchema,
});
export type SamsaraStatRaw = z.infer<typeof samsaraStatRawSchema>;

/**
 * stream 'faults': one vehicle + ONE faultCodes reading (the complete active set at its time).
 * externalId `${id}:faultCodes:${time}`.
 */
export const samsaraFaultRawSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  reading: samsaraFaultCodesReadingSchema,
});
export type SamsaraFaultRaw = z.infer<typeof samsaraFaultRawSchema>;
