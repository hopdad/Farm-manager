/**
 * fleet.vehicles (slice 1f.2; the terminal-pickups builder, docs/contracts-1f.md part B §B.4.8):
 * Samsara's vehicle metadata (CONNECTOR_SAMSARA: `GET /fleet/vehicles`), hourly at :41 (59 s in
 * the demo), stream samsara / vehicles:
 *
 *   each mapped vehicle's tags → farm.machines.kind through VEHICLE_KIND_TAGS (`Pickup`,
 *   `Semi`, `Service truck`; a kind set on /admin/vehicles always wins), and telematics_via where
 *   the record tells it (no Samsara gateway + a Ford → `ford_pro`, a Ram → `stellantis`; an asset
 *   gateway → `gateway`; doc-derived), with `applyVendorVehicle` (src/db/queries/vehicles.ts);
 *   ONE `fleet`/`invalidate` { event: 'machine', reason: 'changed' } per run when a machine
 *   changed, then the stream's sync status.
 *
 * The pickups have no mode key of their own: they ride on Samsara's feeds (fleet.trucks moves
 * them; their carmaker routes report positions every 30 s and fuel only). Only the vehicles the
 * farm maps through ingest.external_refs are landed; nothing is created from the list.
 */
import { getConfig } from '../config';
import { SamsaraVehiclesClient } from '../connectors/samsara/vehicles-client';
import { mapSamsaraVehicle } from '../connectors/samsara/vehicles-mapper';
import type { SamsaraVehicleRaw } from '../connectors/samsara/vehicles-schemas';
import { runSyncStep } from '../connectors/sync-step';
import { type NormalizedVehicle, type SyncStepSpec, syncStepJobResult } from '../connectors/types';
import { allMappedIds, mappedVehicleRefs, vehicleListUpsert } from '../connectors/vehicles/refs';
import { type FleetJobOptions, httpFor, machineResolver, publishSyncStatus } from './fleet-shared';
import type { JobContext, JobResult } from './types';

export const VEHICLES_STREAM = 'vehicles';
export const VEHICLES_LEASE_SECONDS = 90;

export function createFleetVehiclesJob(opts: FleetJobOptions = {}) {
  return async function runFleetVehicles(ctx: JobContext): Promise<JobResult> {
    const cfg = (opts.config ?? getConfig)();
    const mode = cfg.CONNECTOR_SAMSARA;
    const http = httpFor(ctx, opts.http);
    const vehicles = vehicleListUpsert(machineResolver(), publishSyncStatus);
    let client: SamsaraVehiclesClient | null = null;
    const samsara = async () => {
      if (!client) {
        const only = allMappedIds(await mappedVehicleRefs(ctx.pool, 'samsara'));
        client = SamsaraVehiclesClient.forMode(mode, cfg, http, {
          only,
          log: (msg, data) => ctx.log.warn(msg, data),
        });
      }
      return client;
    };
    const spec: SyncStepSpec<SamsaraVehicleRaw, NormalizedVehicle> = {
      source: 'samsara',
      stream: VEHICLES_STREAM,
      mode,
      leaseSeconds: VEHICLES_LEASE_SECONDS,
      poll: async (cursor) => (await samsara()).pollVehicles(cursor),
      map: (raw) => mapSamsaraVehicle(raw, cfg.VEHICLE_KIND_TAGS),
      upsert: vehicles.upsert,
      afterRun: vehicles.afterRun,
    };
    return syncStepJobResult(await runSyncStep(spec, ctx));
  };
}

export const runFleetVehicles = createFleetVehiclesJob();
