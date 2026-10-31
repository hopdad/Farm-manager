/**
 * Motive (formerly KeepTruckin) shapes (slice 1f.2, the trucks builder; docs/contracts-1f.md
 * part B). Confirmed from Motive's official OpenAPI 3.1 and developer-docs.gomotive.com
 * (checked Oct 30, 2026); what the spec leaves open is in ./doc-derived.ts:
 *
 *   GET https://api.gomotive.com/v1/companies                     the company id (sourceOrg)
 *   GET …/v2/vehicle_locations?per_page=&page_no=   (v1 is the same shape; per_page ≤ 100)
 *   GET …/v3/vehicle_locations?per_page=&page_no=   Motive Vehicle Gateway units ONLY
 *   GET …/v1/fault_codes?start_date=&end_date=&per_page=&page_no=   paging at the TOP level
 *   GET …/v1/vehicles, …/v1/groups                                  the vehicle list (kind tags)
 *   X-Api-Key: <key>      X-Metric-Units: false (imperial: mph, miles; the default is ambiguous)
 *
 * v1/v2 send `speed` in MILES PER HOUR and the stats in `current_location` (true_engine_hours,
 * true_odometer: "adjusted for accuracy"; engine_hours, odometer: the raw/virtual values;
 * fuel_primary_remaining_percentage); only v3 sends `kph` and `vehicle_state` (on/off), and no
 * stats at all. Lists page with `pagination { per_page, page_no, total }` (stop when
 * page_no × per_page ≥ total), except /v1/fault_codes, whose paging fields sit at the top level.
 *
 * LENIENT (docs/contracts-1f.md §B.5): the page envelopes are checked here, each item is parsed
 * on its own by the client (a bad item is dropped and logged with its id, never the page), and
 * everything the spec doesn't promise is optional. Shared by the client, the stand-in
 * (src/sim/vendors/motive) and the replay fixtures (./fixtures).
 */
import { z } from 'zod';

/** Motive ids are integers in its docs; the simulated farm uses strings. Read both as strings. */
const id = z.union([z.string().min(1), z.number().int()]).transform((v) => String(v));
/** A number Motive may send as a string ("2024") or null. */
const looseNumber = z.union([z.number(), z.string()]).nullish();
const text = z.string().nullish();

export const motiveLocationSchema = z.looseObject({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Degrees (an integer in v1, nullable in v3). */
  bearing: z.number().nullish(),
  /** v1/v2: miles per hour (with X-Metric-Units: false). */
  speed: z.number().nullish(),
  /** v3 only (Vehicle Gateway units): km/h. */
  kph: z.number().nullish(),
  /** v3 only: the engine state, `on` / `off`. */
  vehicle_state: z.string().nullish(),
  located_at: z.iso.datetime({ offset: true }),
  description: text,
  /** v1/v2: hours, "adjusted for accuracy" (calibrated); prefer it. */
  true_engine_hours: z.number().nullish(),
  /** v1/v2: hours as the gateway reads them (virtual or ECU). */
  engine_hours: z.number().nullish(),
  /** v1/v2: miles, "adjusted for accuracy"; prefer it. */
  true_odometer: z.number().nullish(),
  /** v1/v2: miles, the gateway's virtual odometer. */
  odometer: z.number().nullish(),
  /** v1/v2: 0-100. */
  fuel_primary_remaining_percentage: z.number().nullish(),
});
export type MotiveLocation = z.infer<typeof motiveLocationSchema>;

export const motiveVehicleSchema = z.looseObject({
  id,
  number: text,
  year: looseNumber,
  make: text,
  model: text,
  vin: text,
  current_location: motiveLocationSchema.nullish(),
});
export type MotiveVehicle = z.infer<typeof motiveVehicleSchema>;

/** One `{ vehicle }` entry of a vehicle_locations page (parsed per item by the client). */
export const motiveVehicleLocationItemSchema = z.looseObject({ vehicle: motiveVehicleSchema });

export const motivePaginationSchema = z.looseObject({
  per_page: z.number().int(),
  page_no: z.number().int(),
  total: z.number().int(),
});

/** A v1/v2/v3 vehicle_locations page; items are checked one by one (lenient). */
export const motiveVehicleLocationsPageSchema = z.looseObject({
  vehicles: z.array(z.unknown()),
  pagination: motivePaginationSchema.optional(),
});

/** A whole page, strictly typed (the stand-in and the fixture builder write this shape). */
export const motiveVehicleLocationsSchema = z.looseObject({
  vehicles: z.array(motiveVehicleLocationItemSchema),
  pagination: motivePaginationSchema.optional(),
});
export type MotiveVehicleLocations = z.input<typeof motiveVehicleLocationsSchema>;

// ---- /v1/companies --------------------------------------------------------------------------

export const motiveCompaniesSchema = z.looseObject({
  companies: z.array(
    z.looseObject({
      company: z.looseObject({
        id,
        company_id: text,
        name: text,
        metric_units: z.boolean().nullish(),
      }),
    }),
  ),
  pagination: motivePaginationSchema.optional(),
});
export type MotiveCompanies = z.input<typeof motiveCompaniesSchema>;

// ---- /v1/fault_codes ------------------------------------------------------------------------

export const motiveFaultCodeSchema = z.looseObject({
  id,
  code: text,
  code_label: text,
  code_description: text,
  /** `open` or `closed`. */
  status: z.string(),
  first_observed_at: z.iso.datetime({ offset: true }).nullish(),
  last_observed_at: z.iso.datetime({ offset: true }).nullish(),
  /** `constant` or `intermittent`. */
  type: text,
  /** J1939 / J1587 failure mode identifier. */
  fmi: looseNumber,
  fmi_description: text,
  occurrence_count: looseNumber,
  num_observations: looseNumber,
  source_address: looseNumber,
  source_address_label: text,
  source_address_name: text,
  is_sid: z.boolean().nullish(),
  /** OEM DTC fields (null for OBD-II in Motive's examples). */
  dtc_status: text,
  dtc_severity: text,
  /** e.g. `obdii`, `j1587/j1708` (the J1939 value has no example: doc-derived). */
  network: text,
  vehicle: z.looseObject({ id, number: text }).nullish(),
});
export type MotiveFaultCode = z.infer<typeof motiveFaultCodeSchema>;

/** One `{ fault_code }` entry (parsed per item by the client). */
export const motiveFaultCodeItemSchema = z.looseObject({ fault_code: motiveFaultCodeSchema });

/** /v1/fault_codes: `per_page`, `page_no`, `total` at the TOP level (no `pagination` wrapper). */
export const motiveFaultCodesPageSchema = z.looseObject({
  fault_codes: z.array(z.unknown()),
  per_page: z.number().int().optional(),
  page_no: z.number().int().optional(),
  total: z.number().int().optional(),
});

export const motiveFaultCodesSchema = motiveFaultCodesPageSchema.extend({
  fault_codes: z.array(motiveFaultCodeItemSchema),
});
export type MotiveFaultCodes = z.input<typeof motiveFaultCodesSchema>;

// ---- /v1/vehicles and /v1/groups ------------------------------------------------------------

export const motiveVehicleListItemSchema = z.looseObject({
  vehicle: z.looseObject({
    id,
    number: text,
    status: text,
    make: text,
    model: text,
    year: looseNumber,
    vin: text,
    group_ids: z.array(id).nullish(),
    /** Present when the vehicle has a Motive Vehicle Gateway (v3 lists it). */
    eld_device: z.looseObject({ id, identifier: text, model: text }).nullish(),
  }),
});
export type MotiveVehicleListItem = z.infer<typeof motiveVehicleListItemSchema>;

export const motiveVehiclesPageSchema = z.looseObject({
  vehicles: z.array(z.unknown()),
  pagination: motivePaginationSchema.optional(),
});
export const motiveVehiclesSchema = motiveVehiclesPageSchema.extend({
  vehicles: z.array(motiveVehicleListItemSchema),
});
export type MotiveVehicles = z.input<typeof motiveVehiclesSchema>;

export const motiveGroupsSchema = z.looseObject({
  groups: z.array(z.looseObject({ group: z.looseObject({ id, name: text }) })),
  pagination: motivePaginationSchema.optional(),
});
export type MotiveGroups = z.input<typeof motiveGroupsSchema>;

/** Motive's error body (`{"error_message": "invalid API key"}`). */
export const motiveErrorSchema = z.looseObject({ error_message: z.string() });

// ---- Raw items (what lands in ingest.raw_events) --------------------------------------------

/**
 * Stream 'positions': one vehicle's current location. externalId `${id}:${located_at}`.
 * `companyId` (the sourceOrg) and `api` (which list it came from: v3 for gateway units, v2 for
 * the rest) arrived in 1f.2; a 1a item has neither (sourceOrg '').
 */
export const motivePositionRawSchema = z.object({
  id: z.string().min(1),
  number: z.string().nullish(),
  companyId: z.string().optional(),
  api: z.enum(['v1', 'v2', 'v3']).optional(),
  location: motiveLocationSchema,
});
export type MotivePositionRaw = z.infer<typeof motivePositionRawSchema>;

/** Stream 'stats': one vehicle's v2 current_location (its stats). externalId `${id}:stats:${located_at}`. */
export const motiveStatRawSchema = z.object({
  id: z.string().min(1),
  number: z.string().nullish(),
  companyId: z.string(),
  location: motiveLocationSchema,
});
export type MotiveStatRaw = z.infer<typeof motiveStatRawSchema>;

/** Stream 'faults': one fault record. externalId `${vehicle}:fault:${id}:${status}:${last_observed_at}`. */
export const motiveFaultRawSchema = z.object({
  companyId: z.string(),
  fault: motiveFaultCodeSchema,
});
export type MotiveFaultRaw = z.infer<typeof motiveFaultRawSchema>;

/** Stream 'vehicles': one vehicle of /v1/vehicles with its group names. */
export const motiveVehicleRawSchema = z.object({
  companyId: z.string(),
  vehicle: motiveVehicleListItemSchema.shape.vehicle,
  groups: z.array(z.string()),
});
export type MotiveVehicleRaw = z.infer<typeof motiveVehicleRawSchema>;
