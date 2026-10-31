/**
 * Samsara vehicle metadata in the stand-in (slice 1f.2; the terminal-pickups builder,
 * docs/contracts-1f.md part B §B.7): `GET /fleet/vehicles` ("List all vehicles", Samsara's
 * OpenAPI listVehicles; the shapes of src/connectors/samsara/vehicles-schemas.ts), so the
 * vehicle-kind sync can set farm.machines.kind from a vendor tag and telematics_via from what
 * the record says:
 *
 *   GET /fleet/vehicles?limit=&after=     Authorization: Bearer SIM_CREDENTIALS.samsara.apiToken
 *   → { data: [{ id, name, createdAtTime, updatedAtTime, make, model, year (a string), vin?,
 *               tags: [{ id, name }], gateway?: { model, serial }, vehicleRegulationMode }],
 *       pagination: { endCursor, hasNextPage } }
 *
 * The vehicles are the ones on Samsara's vehicle feeds (`simTelematicsMachines(farm, 'samsara',
 * { feed: 'vehicle' })`: the four semis and the two pickups) under their feed ids, with the
 * world's tags (`SimTelematics.tags`: Semi, Pickup). A truck has a Samsara vehicle gateway
 * (VG54NA); a carmaker-cloud pickup (via ford_pro / stellantis) has NO gateway and its maker's
 * make (Ford, Ram): how a real record of such a vehicle is expected to look (doc-derived: Samsara
 * documents no carmaker flag). Knob: ./vehicles-routes-control.ts (re-tag a vehicle).
 */
import { randomUUID } from 'node:crypto';
import { SAMSARA_VEHICLES_LIMIT } from '../../../connectors/samsara/vehicles-schemas';
import { simTelematicsMachines } from '../../types';
import type { VendorContext, VendorControlContext } from '../context';
import { json, type SimRequest, type SimResponse } from '../http';
import { type SamsaraRouteModule, samsaraModuleState } from './modules';
import {
  type SamsaraVehiclesSimState,
  type SamsaraVehiclesSimStatus,
  samsaraVehiclesSimStateSchema,
  samsaraVehicleTagsRequestSchema,
} from './vehicles-routes-control';
import { samsaraVehicleRecord } from './vehicles-routes-record';

function samsaraError(status: number, message: string) {
  return json(status, { message, requestId: randomUUID() });
}

function readState(ctx: { state: VendorContext['state'] }): SamsaraVehiclesSimState {
  const r = samsaraVehiclesSimStateSchema.safeParse(samsaraModuleState(ctx, 'vehicles'));
  return r.success ? r.data : { tags: {} };
}

function vehiclesOf(ctx: { world: VendorContext['world'] }) {
  return simTelematicsMachines(ctx.world.farm, 'samsara', { feed: 'vehicle' });
}

function listVehicles(req: SimRequest, ctx: VendorContext): SimResponse {
  const raw = req.url.searchParams.get('limit');
  const limit = raw ? Number(raw) : SAMSARA_VEHICLES_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > SAMSARA_VEHICLES_LIMIT) {
    return samsaraError(400, `limit must be between 1 and ${SAMSARA_VEHICLES_LIMIT}`);
  }
  const after = req.url.searchParams.get('after');
  let offset = 0;
  if (after) {
    const text = Buffer.from(after, 'base64url').toString('utf8');
    const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isInteger(n) || n < 0) return samsaraError(400, 'Invalid cursor: after');
    offset = n;
  }
  const s = readState(ctx);
  const all = vehiclesOf(ctx).map((m) => samsaraVehicleRecord(m, s.tags[m.telematics?.id ?? '']));
  const data = all.slice(offset, offset + limit);
  const more = offset + limit < all.length;
  return json(200, {
    data,
    pagination: {
      endCursor: more ? Buffer.from(String(offset + limit)).toString('base64url') : '',
      hasNextPage: more,
    },
  });
}

function statusOf(ctx: { world: VendorContext['world'] }, s: SamsaraVehiclesSimState) {
  const out: SamsaraVehiclesSimStatus = {
    vehicles: vehiclesOf(ctx).map((m) => {
      const id = m.telematics?.id ?? '';
      const override = s.tags[id];
      return {
        id,
        unitNo: m.unitNo,
        tags: override ?? m.telematics?.tags ?? [],
        overridden: !!override,
      };
    }),
  };
  return out;
}

function control(req: SimRequest, ctx: VendorControlContext): SimResponse | null {
  if (req.path !== '/tags') return null;
  const s = readState(ctx);
  if (req.method === 'GET') return json(200, statusOf(ctx, s));
  if (req.method !== 'POST') return json(405, { error: `${req.method} not allowed` });
  let body: unknown;
  try {
    body = JSON.parse(req.body || '{}');
  } catch {
    return json(400, { error: 'body is not JSON' });
  }
  const r = samsaraVehicleTagsRequestSchema.safeParse(body);
  if (!r.success) return json(400, { error: 'expected { vehicleId, tags: string[] | null }' });
  if (!vehiclesOf(ctx).some((m) => m.telematics?.id === r.data.vehicleId)) {
    return json(400, { error: `no Samsara vehicle ${r.data.vehicleId}` });
  }
  if (r.data.tags === null) delete s.tags[r.data.vehicleId];
  else s.tags[r.data.vehicleId] = r.data.tags;
  Object.assign(samsaraModuleState(ctx, 'vehicles'), s);
  ctx.persist();
  ctx.log(`samsara: vehicle ${r.data.vehicleId} tags ${r.data.tags?.join(', ') ?? '(world)'}`);
  return json(200, statusOf(ctx, s));
}

export const samsaraVehiclesModule: SamsaraRouteModule = {
  key: 'vehicles',
  route(req, ctx) {
    if (req.path !== '/fleet/vehicles') return null;
    if (req.method !== 'GET') return samsaraError(405, 'Method not allowed');
    return listVehicles(req, ctx);
  },
  control,
};
