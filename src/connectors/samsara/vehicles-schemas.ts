/**
 * Samsara's vehicle list (slice 1f.2, terminal-pickups; docs/contracts-1f.md part B §B.1, the
 * pickups route): `GET /fleet/vehicles` ("List all vehicles", operationId listVehicles in
 * Samsara's OpenAPI, developers.samsara.com/openapi/samsara-api.json; scope Read Vehicles):
 *
 *   GET https://api.samsara.com/fleet/vehicles?limit=512&after=<endCursor>
 *   → { data: Vehicle[], pagination: { endCursor, hasNextPage } }
 *
 * A Vehicle has `id` and `createdAtTime` (required), `name`, `make`, `model`, `year` (a
 * STRING), `vin`, `tags` (`{ id, name, parentTagId? }`, customer-defined), an optional `gateway`
 * (`{ model, serial }`, Samsara hardware only: AG*, AT*, IG*, SG*, VG*), `externalIds`,
 * `vehicleRegulationMode`. Nothing marks a vehicle as Ford Pro or Stellantis sourced: the via is
 * inferred (./vehicles-mapper.ts, doc-derived).
 *
 * LENIENT (§B.5): the page envelope is checked here, each vehicle on its own by the client (a bad
 * one is dropped and logged with its id), objects keep unknown keys, optional what the spec
 * doesn't require.
 */
import { z } from 'zod';

const text = z.string().nullish();

export const samsaraTagSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  parentTagId: z.string().nullish(),
});

export const samsaraVehicleSchema = z.looseObject({
  id: z.string().min(1),
  name: text,
  createdAtTime: z.string().nullish(),
  updatedAtTime: z.string().nullish(),
  make: text,
  model: text,
  /** A string in Samsara's spec ("2008"). */
  year: z.union([z.string(), z.number()]).nullish(),
  vin: text,
  tags: z.array(samsaraTagSchema).nullish(),
  /** The Samsara gateway installed on the vehicle; absent for a carmaker-cloud vehicle. */
  gateway: z.looseObject({ model: text, serial: text }).nullish(),
  externalIds: z.record(z.string(), z.string()).nullish(),
  vehicleRegulationMode: text,
});
export type SamsaraVehicle = z.infer<typeof samsaraVehicleSchema>;

/** One page of GET /fleet/vehicles; vehicles are parsed one by one (lenient). */
export const samsaraVehiclesPageSchema = z.looseObject({
  data: z.array(z.unknown()),
  pagination: z.looseObject({ endCursor: z.string(), hasNextPage: z.boolean() }),
});
export type SamsaraVehiclesPage = z.infer<typeof samsaraVehiclesPageSchema>;

/** What the client lands per vehicle (the vehicle as Samsara lists it). */
export interface SamsaraVehicleRaw {
  vehicle: SamsaraVehicle;
}

/** Samsara's page size maximum for /fleet/vehicles ("Default and max for this value is 512"). */
export const SAMSARA_VEHICLES_LIMIT = 512;
