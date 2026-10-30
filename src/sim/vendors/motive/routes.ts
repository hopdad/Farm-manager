/**
 * Motive stand-in (mounted at /motive): a THIN placeholder until the 1f.2 trucks builder
 * (docs/contracts-1f.md part B) fills it in (positions v1/v2 and v3 for Vehicle Gateway units,
 * stats, /v1/fault_codes).
 *
 *   GET /v1/vehicle_locations?per_page=&page_no=   X-Api-Key: SIM_CREDENTIALS.motive.apiKey
 *   // doc-derived, confirm (path, header, field names)
 *
 * Current location of each Motive vehicle (`simTelematicsMachines(farm, 'motive')`: 1f.2's
 * hired hauler H1) at the latest GPS grid instant (no history feed).
 */
import type { MotiveVehicleLocations } from '../../../connectors/motive/schemas';
import { SIM_CREDENTIALS, simTelematicsMachines } from '../../types';
import type { VendorModule } from '../context';
import { firstOfKind } from '../faults';
import { round } from '../feed';
import { header, json } from '../http';

function motiveError(status: number, message: string, headers: Record<string, string> = {}) {
  return json(status, { error_message: message }, headers);
}

export const motiveModule: VendorModule = {
  vendor: 'motive',
  error: motiveError,
  handle(req, ctx) {
    if (header(req.headers, 'x-api-key') !== SIM_CREDENTIALS.motive.apiKey) {
      return motiveError(401, 'Unauthorized');
    }
    if (firstOfKind(ctx.faults, 'token_revoked') ?? firstOfKind(ctx.faults, 'token_expired')) {
      return motiveError(401, 'API key expired or revoked');
    }
    if (req.method !== 'GET' || req.path !== '/v1/vehicle_locations') {
      return motiveError(404, `Not found: ${req.path} (not simulated)`);
    }
    const perPage = Math.min(100, Math.max(1, Number(req.url.searchParams.get('per_page') ?? 25)));
    const pageNo = Math.max(1, Number(req.url.searchParams.get('page_no') ?? 1));
    const step = ctx.tuning.gpsIntervalMs;
    const t = Math.floor(ctx.now().getTime() / step) * step;
    const all: MotiveVehicleLocations['vehicles'] = [];
    for (const m of simTelematicsMachines(ctx.world.farm, 'motive')) {
      const s = ctx.world.machineAt(m.id, ctx.simAt(new Date(t)));
      all.push({
        vehicle: {
          id: m.telematics?.id ?? '',
          number: m.unitNo,
          current_location: s
            ? {
                lat: round(s.lat, 6),
                lon: round(s.lng, 6),
                bearing: round(s.heading, 1),
                kph: round(Math.max(0, s.speedMph) * 1.609344, 1),
                located_at: new Date(t).toISOString(),
                description: null,
              }
            : null,
        },
      });
    }
    const body: MotiveVehicleLocations = {
      vehicles: all.slice((pageNo - 1) * perPage, pageNo * perPage),
      pagination: { per_page: perPage, page_no: pageNo, total: all.length },
    };
    return json(200, body);
  },
};
