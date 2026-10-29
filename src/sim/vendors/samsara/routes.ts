/**
 * Samsara stand-in (mounted at /samsara): the cursor feeds the fleet.trucks job polls, computed
 * from the simulated world (contracts §9: sample `machineAt(id, simAt(wall))`, stamp `wall`).
 *
 *   GET /fleet/vehicles/locations/feed?after=&vehicleIds=
 *   GET /fleet/vehicles/stats/feed?types=obdEngineSeconds,fuelPercents,obdOdometerMeters&after=
 *   Authorization: Bearer SIM_CREDENTIALS.samsara.apiToken
 *
 * Shapes are typed by the shared zod schemas (src/connectors/samsara/schemas.ts). Vehicles are
 * the SimFarm machines with `vendorIds.eld` (named by unit number).
 */
import { randomUUID } from 'node:crypto';
import {
  SAMSARA_STAT_TYPES,
  type SamsaraLocation,
  type SamsaraLocationsFeed,
  type SamsaraStatsFeed,
  type SamsaraStatType,
  type SamsaraVehicleStats,
} from '../../../connectors/samsara/schemas';
import { SIM_CREDENTIALS, type SimMachineSample } from '../../types';
import type { VendorContext, VendorModule } from '../context';
import { firstOfKind } from '../faults';
import {
  decodeFeedCursor,
  encodeFeedCursor,
  type FeedWindow,
  feedWindow,
  round,
  seededShuffle,
} from '../feed';
import { bearerToken, json, type SimRequest, type SimResponse } from '../http';

interface FeedVehicle {
  id: string;
  name: string;
  machineId: string;
}

function samsaraError(status: number, message: string, headers: Record<string, string> = {}) {
  return json(status, { message, requestId: randomUUID() }, headers);
}

/** Machines with an ELD id, optionally filtered by `vehicleIds=a,b`. */
function vehicles(ctx: VendorContext, url: URL): FeedVehicle[] {
  const all = ctx.world.farm.machines
    .filter((m) => m.vendorIds.eld)
    .map((m) => ({ id: m.vendorIds.eld as string, name: m.unitNo, machineId: m.id }));
  const filter = url.searchParams.get('vehicleIds');
  if (!filter) return all;
  const ids = new Set(filter.split(',').map((s) => s.trim()));
  return all.filter((v) => ids.has(v.id));
}

function sample(ctx: VendorContext, machineId: string, wallMs: number): SimMachineSample | null {
  const wall = new Date(wallMs);
  return ctx.world.machineAt(machineId, ctx.simAt(wall));
}

function toLocation(s: SimMachineSample, wallMs: number): SamsaraLocation {
  return {
    time: new Date(wallMs).toISOString(),
    latitude: round(s.lat, 6),
    longitude: round(s.lng, 6),
    heading: round(s.heading, 1),
    speed: round(Math.max(0, s.speedMph), 1),
    isEcuSpeed: false,
  };
}

/** Resolve the request's window, or an error reply for a bad cursor. */
function windowFor(
  req: SimRequest,
  ctx: VendorContext,
  intervalMs: number,
  nVehicles: number,
): FeedWindow | SimResponse {
  const after = req.url.searchParams.get('after');
  let afterMs: number | null = null;
  if (after) {
    afterMs = decodeFeedCursor(after);
    if (afterMs === null) return samsaraError(400, 'Invalid cursor: after');
  }
  return feedWindow({
    afterMs,
    nowMs: ctx.now().getTime(),
    intervalMs,
    perPage: Math.floor(ctx.tuning.maxEventsPerPage / Math.max(1, nVehicles)),
    maxCatchUpMs: ctx.tuning.maxFeedCatchUpMs,
  });
}

/** duplicate_page: answer the previous page again (its endCursor = this request's `after`). */
function duplicateOf(req: SimRequest, ctx: VendorContext, key: string): SimResponse | null {
  if (!firstOfKind(ctx.faults, 'duplicate_page')) return null;
  const prev = ctx.lastPages.get(key);
  const after = req.url.searchParams.get('after');
  const body = prev?.body as { pagination?: { endCursor?: string } } | undefined;
  if (!body || !after || body.pagination?.endCursor !== after) return null;
  ctx.counters.faults.duplicate_page = (ctx.counters.faults.duplicate_page ?? 0) + 1;
  return json(200, body);
}

function locationsFeed(req: SimRequest, ctx: VendorContext): SimResponse {
  const key = `samsara:locations:${req.url.searchParams.get('vehicleIds') ?? ''}`;
  const dup = duplicateOf(req, ctx, key);
  if (dup) return dup;
  const vs = vehicles(ctx, req.url);
  const win = windowFor(req, ctx, ctx.tuning.gpsIntervalMs, vs.length);
  if ('kind' in win) return win;
  let data: SamsaraLocationsFeed['data'] = [];
  for (const v of vs) {
    const locations: SamsaraLocation[] = [];
    for (const t of win.instants) {
      const s = sample(ctx, v.machineId, t);
      if (s) locations.push(toLocation(s, t));
    }
    if (locations.length) data.push({ id: v.id, name: v.name, locations });
  }
  if (firstOfKind(ctx.faults, 'out_of_order')) {
    ctx.counters.faults.out_of_order = (ctx.counters.faults.out_of_order ?? 0) + 1;
    data = seededShuffle(data, req.seq).map((d, i) => ({
      ...d,
      locations: seededShuffle(d.locations, req.seq + i + 1),
    }));
  }
  const body: SamsaraLocationsFeed = {
    data,
    pagination: { endCursor: encodeFeedCursor(win.endMs), hasNextPage: win.hasNextPage },
  };
  ctx.lastPages.set(key, { after: req.url.searchParams.get('after'), body });
  return json(200, body);
}

function statValue(type: SamsaraStatType, s: SimMachineSample): number {
  switch (type) {
    case 'obdEngineSeconds':
      return Math.round(s.engineHours * 3600);
    case 'fuelPercents':
      return Math.round(s.fuelPct);
    case 'obdOdometerMeters':
      return Math.round(s.odometerMi * 1609.344);
  }
}

function statsFeed(req: SimRequest, ctx: VendorContext): SimResponse {
  const raw = req.url.searchParams.get('types');
  if (!raw) return samsaraError(400, 'Missing required parameter: types');
  const types = [...new Set(raw.split(',').map((s) => s.trim()))];
  if (types.length > 3) return samsaraError(400, 'At most 3 stat types may be requested');
  const unknown = types.filter((t) => !(SAMSARA_STAT_TYPES as readonly string[]).includes(t));
  if (unknown.length) return samsaraError(400, `Unsupported stat types: ${unknown.join(',')}`);
  const key = `samsara:stats:${types.join(',')}:${req.url.searchParams.get('vehicleIds') ?? ''}`;
  const dup = duplicateOf(req, ctx, key);
  if (dup) return dup;
  const vs = vehicles(ctx, req.url);
  const win = windowFor(req, ctx, ctx.tuning.statsIntervalMs, vs.length * types.length);
  if ('kind' in win) return win;
  const data: SamsaraStatsFeed['data'] = [];
  for (const v of vs) {
    const row: SamsaraVehicleStats = { id: v.id, name: v.name };
    let any = false;
    for (const t of win.instants) {
      const s = sample(ctx, v.machineId, t);
      if (!s) continue;
      any = true;
      for (const type of types as SamsaraStatType[]) {
        const list = row[type] ?? [];
        list.push({ time: new Date(t).toISOString(), value: statValue(type, s) });
        row[type] = list;
      }
    }
    if (any) data.push(row);
  }
  const body: SamsaraStatsFeed = {
    data,
    pagination: { endCursor: encodeFeedCursor(win.endMs), hasNextPage: win.hasNextPage },
  };
  ctx.lastPages.set(key, { after: req.url.searchParams.get('after'), body });
  return json(200, body);
}

export const samsaraModule: VendorModule = {
  vendor: 'samsara',
  error: samsaraError,
  handle(req, ctx) {
    const token = bearerToken(req.headers);
    if (token !== SIM_CREDENTIALS.samsara.apiToken) {
      return samsaraError(401, 'Unauthorized: invalid API token');
    }
    // Samsara API tokens are static: an "expired" or revoked token fails until the fault ends.
    const auth =
      firstOfKind(ctx.faults, 'token_revoked') ?? firstOfKind(ctx.faults, 'token_expired');
    if (auth) {
      ctx.counters.faults[auth.kind] = (ctx.counters.faults[auth.kind] ?? 0) + 1;
      return samsaraError(401, 'Unauthorized: API token expired or revoked');
    }
    if (req.method !== 'GET') return samsaraError(405, 'Method not allowed');
    switch (req.path) {
      case '/fleet/vehicles/locations/feed':
        return locationsFeed(req, ctx);
      case '/fleet/vehicles/stats/feed':
        return statsFeed(req, ctx);
      default:
        return samsaraError(404, `Not found: ${req.path} (not simulated)`);
    }
  },
};
