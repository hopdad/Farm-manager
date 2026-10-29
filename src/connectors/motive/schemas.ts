/**
 * Motive (formerly KeepTruckin) shapes: a THIN placeholder until D3 picks the ELD vendor
 * (plan §5: "Motive: vehicle locations API plus webhooks (paths to confirm)").
 *
 *   GET https://api.gomotive.com/v1/vehicle_locations?per_page=&page_no=   // doc-derived, confirm
 *   X-Api-Key: <key>                                                        // doc-derived, confirm
 *
 * Only the current location of each vehicle is read; history, webhooks and HOS arrive with the
 * vendor decision. Shared by the client and the stand-in (src/sim/vendors/motive).
 */
import { z } from 'zod';

/** Motive ids are integers in its docs; the simulated farm uses strings. Read both as strings. */
const id = z.union([z.string().min(1), z.number().int()]).transform((v) => String(v));

export const motiveLocationSchema = z.looseObject({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Degrees. // doc-derived, confirm */
  bearing: z.number().nullish(),
  /** km/h. // doc-derived, confirm */
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
