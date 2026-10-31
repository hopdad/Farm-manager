/**
 * Motive (formerly KeepTruckin) shapes: the 1a placeholder the 1f.2 trucks builder grows
 * (docs/contracts-1f.md part B). Confirmed from Motive's official OpenAPI 3.1 and
 * developer-docs.gomotive.com (Oct 30, 2026):
 *
 *   GET https://api.gomotive.com/v1/vehicle_locations?per_page=&page_no=   (per_page ≤ 100)
 *   X-Api-Key: <key>      X-Metric-Units: false (imperial: mph, miles; the default is ambiguous)
 *
 * v1/v2 send `speed` in MILES PER HOUR (and the stats: true_engine_hours, true_odometer,
 * fuel_primary_remaining_percentage); only v3 (Motive Vehicle Gateway units) sends `kph`.
 * Only the current location of each vehicle is read here. Shared by the client and the stand-in
 * (src/sim/vendors/motive).
 */
import { z } from 'zod';

/** Motive ids are integers in its docs; the simulated farm uses strings. Read both as strings. */
const id = z.union([z.string().min(1), z.number().int()]).transform((v) => String(v));

export const motiveLocationSchema = z.looseObject({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Degrees (an integer in v1, nullable in v3). */
  bearing: z.number().nullish(),
  /** v1/v2: miles per hour (with X-Metric-Units: false). */
  speed: z.number().nullish(),
  /** v3 only (Vehicle Gateway units): km/h. */
  kph: z.number().nullish(),
  located_at: z.iso.datetime({ offset: true }),
  description: z.string().nullish(),
});
export type MotiveLocation = z.infer<typeof motiveLocationSchema>;

export const motiveVehicleSchema = z.looseObject({
  id,
  number: z.string().nullish(),
  current_location: motiveLocationSchema.nullish(),
});

export const motiveVehicleLocationsSchema = z.looseObject({
  vehicles: z.array(z.looseObject({ vehicle: motiveVehicleSchema })),
  pagination: z
    .looseObject({ per_page: z.number().int(), page_no: z.number().int(), total: z.number().int() })
    .optional(),
});
export type MotiveVehicleLocations = z.infer<typeof motiveVehicleLocationsSchema>;

/** Raw item (stream 'positions'): one vehicle's current location. externalId `${id}:${located_at}`. */
export const motivePositionRawSchema = z.object({
  id: z.string().min(1),
  number: z.string().nullish(),
  location: motiveLocationSchema,
});
export type MotivePositionRaw = z.infer<typeof motivePositionRawSchema>;
