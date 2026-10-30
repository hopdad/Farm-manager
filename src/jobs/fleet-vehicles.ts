/**
 * fleet.vehicles (slice 1f.2; owner: the terminal-pickups builder, docs/contracts-1f.md part B): vehicle metadata (CONNECTOR_SAMSARA: GET /fleet/vehicles): each vehicle's tags → farm.machines.kind through VEHICLE_KIND_TAGS (a kind set on /admin always wins) and telematics_via where the vendor says it (ford_pro, stellantis), with `applyVendorVehicle` (src/db/queries/vehicles.ts).
 *
 * Foundation stub: registered (src/jobs/registry.ts) so the clock and CI stay green while the
 * builder works; it does nothing yet.
 */
import type { JobContext, JobResult } from './types';

export async function runFleetVehicles(_ctx: JobContext): Promise<JobResult> {
  return { items: 0, note: 'not built yet' };
}
