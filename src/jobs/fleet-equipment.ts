/**
 * fleet.equipment (slice 1f.2; owner: the machines builder, docs/contracts-1f.md part B): Samsara equipment feeds (CONNECTOR_SAMSARA): /fleet/equipment/locations/feed and /fleet/equipment/stats/feed (gps, fuelPercents, gatewayJ1939EngineSeconds / synthetic engine seconds) for machines on Samsara asset gateways (the demo's RoGator), with telematics_via gateway.
 *
 * Foundation stub: registered (src/jobs/registry.ts) so the clock and CI stay green while the
 * builder works; it does nothing yet.
 */
import type { JobContext, JobResult } from './types';

export async function runFleetEquipment(_ctx: JobContext): Promise<JobResult> {
  return { items: 0, note: 'not built yet' };
}
