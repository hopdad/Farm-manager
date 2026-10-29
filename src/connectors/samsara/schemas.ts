/**
 * Samsara API shapes (zod), shared by the live client (src/connectors/samsara/client.ts) and the
 * vendor stand-in (src/sim/vendors/samsara), so the same schemas validate real and simulated
 * responses (plan §5).
 *
 * Source: Samsara's public API reference as published in its official SDK
 * (@samsarahq/samsara 14.11, types VehicleLocationsListResponse, VehicleLocation,
 * PaginationResponse, VehicleStatsListResponse, *ErrorResponseBody), checked Oct 29, 2026.
 *   GET https://api.samsara.com/fleet/vehicles/locations/feed?after=&vehicleIds=&tagIds=
 *   GET https://api.samsara.com/fleet/vehicles/stats/feed?types=a,b,c&after=   (at most 3 types)
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
  /** GPS speed in miles per hour (`isEcuSpeed` says whether it came from the ECU). */
  speed: z.number().optional(),
  isEcuSpeed: z.boolean().optional(),
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
