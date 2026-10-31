/**
 * The Samsara vehicle-list module's control API (slice 1f.2, terminal-pickups;
 * docs/contracts-1f.md §B.7), served at `${VENDOR_SIM_URL}/_control/vendor/samsara/vehicles/…`
 * behind the stand-in's loopback/Origin/JSON guard:
 *
 *   GET  /_control/vendor/samsara/vehicles/tags   -> SamsaraVehiclesSimStatus
 *   POST /_control/vendor/samsara/vehicles/tags   { vehicleId, tags: string[] | null }
 *        replaces a vehicle's tag names in GET /fleet/vehicles (a farm re-tagging a truck in
 *        Samsara's dashboard); null goes back to the world's (`SimTelematics.tags`)
 *
 * Kept in `state.vendors['samsara.vehicles']`; cleared by /_control/reset. Types and zod only.
 */
import { z } from 'zod';

export const SAMSARA_SIM_VEHICLE_TAGS_PATH = '/_control/vendor/samsara/vehicles/tags';

export const samsaraVehiclesSimStateSchema = z.object({
  tags: z.record(z.string(), z.array(z.string())),
});
export type SamsaraVehiclesSimState = z.infer<typeof samsaraVehiclesSimStateSchema>;

export const samsaraVehicleTagsRequestSchema = z.strictObject({
  vehicleId: z.string().min(1),
  tags: z.array(z.string().min(1).max(100)).max(20).nullable(),
});
export type SamsaraVehicleTagsRequest = z.infer<typeof samsaraVehicleTagsRequestSchema>;

export interface SamsaraVehiclesSimStatus {
  vehicles: { id: string; unitNo: string; tags: string[]; overridden: boolean }[];
}
