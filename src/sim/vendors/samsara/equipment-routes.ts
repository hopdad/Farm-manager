/**
 * Samsara equipment feeds in the stand-in (slice 1f.2; owner: the machines builder,
 * docs/contracts-1f.md part B): the asset-gateway machines
 * (`simTelematicsMachines(farm, 'samsara', { feed: 'equipment' })`: the demo's RoGator SP2).
 *
 *   GET /fleet/equipment/locations/feed?after=           every 5 s grid instant (tuning.gpsIntervalMs)
 *   GET /fleet/equipment/stats/feed?types=a,b,c,d&after=  every 60 s (tuning.statsIntervalMs);
 *       at most 4 types (400 otherwise), any of getEquipmentStatsFeed's enum; the ones the
 *       stand-in sends: gps, fuelPercents, engineRpm, obdEngineSeconds, gatewayEngineSeconds,
 *       gatewayJ1939EngineSeconds (which of the three: the `hoursFrom` knob), obdEngineStates,
 *       gatewayEngineStates, gpsOdometerMeters; no DEF and no faults (none exist on the feed)
 *
 * Cursor feeds like the vehicle feeds (../feed.ts): no `after` = each machine's latest event;
 * `after` = everything since, paged. Samsara's rate limits for these paths (its rate-limit page:
 * 5 req/s locations, 10 req/s stats) answer 429 with a fractional Retry-After. Knobs:
 * ./equipment-routes-types.ts (`hoursFrom`, `silent`), at /_control/vendor/samsara/equipment/….
 */
import { randomUUID } from 'node:crypto';
import {
  SAMSARA_EQUIPMENT_MAX_TYPES,
  SAMSARA_EQUIPMENT_STAT_TYPES,
  type SamsaraEquipmentStatType,
} from '../../../connectors/samsara/equipment-schemas';
import { type SimMachine, type SimMachineSample, simTelematicsMachines } from '../../types';
import type { VendorContext } from '../context';
import { firstIssue } from '../control';
import { decodeFeedCursor, encodeFeedCursor, type FeedWindow, feedWindow, round } from '../feed';
import { json, type SimRequest, type SimResponse } from '../http';
import {
  DEFAULT_EQUIPMENT_SETTINGS,
  type SamsaraEquipmentSettings,
  samsaraEquipmentSettingsRequestSchema,
} from './equipment-routes-types';
import { type SamsaraRouteModule, samsaraModuleState } from './modules';

/** Samsara's per-endpoint limits (requests per second, per org). */
export const EQUIPMENT_RATE_LIMITS: Record<string, number> = {
  '/fleet/equipment/locations/feed': 5,
  '/fleet/equipment/stats/feed': 10,
};

/** Synthetic hours drift from the ECU's (gateway power time) and the J1939 offset, in hours. */
const GATEWAY_DRIFT_H = 2.5;
const J1939_OFFSET_H = 0.5;

function samsaraError(status: number, message: string, headers: Record<string, string> = {}) {
  return json(status, { message, requestId: randomUUID() }, headers);
}

function settingsOf(ctx: { state: VendorContext['state'] }): SamsaraEquipmentSettings {
  const bag = samsaraModuleState(ctx, 'equipment') as Partial<SamsaraEquipmentSettings>;
  return {
    hoursFrom: bag.hoursFrom ?? [...DEFAULT_EQUIPMENT_SETTINGS.hoursFrom],
    silent: bag.silent ?? DEFAULT_EQUIPMENT_SETTINGS.silent,
  };
}

/** Request times per stand-in instance and path (real wall time: the limit is Samsara's). */
const recent = new WeakMap<object, Map<string, number[]>>();

function rateLimited(ctx: VendorContext, path: string): SimResponse | null {
  const limit = EQUIPMENT_RATE_LIMITS[path];
  if (!limit) return null;
  const byPath = recent.get(ctx.state) ?? new Map<string, number[]>();
  recent.set(ctx.state, byPath);
  const now = Date.now();
  const times = (byPath.get(path) ?? []).filter((t) => t > now - 1000);
  if (times.length >= limit) {
    byPath.set(path, times);
    const wait = Math.max(0.05, (times[0] as number) + 1000 - now) / 1000;
    return samsaraError(429, 'Exceeded rate limit.', { 'retry-after': wait.toFixed(3) });
  }
  times.push(now);
  byPath.set(path, times);
  return null;
}

function machines(ctx: VendorContext): SimMachine[] {
  return simTelematicsMachines(ctx.world.farm, 'samsara', { feed: 'equipment' });
}

function sample(ctx: VendorContext, m: SimMachine, wallMs: number): SimMachineSample | null {
  return ctx.world.machineAt(m.id, ctx.simAt(new Date(wallMs)));
}

function windowFor(
  req: SimRequest,
  ctx: VendorContext,
  intervalMs: number,
  perInstant: number,
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
    perPage: Math.floor(ctx.tuning.maxEventsPerPage / Math.max(1, perInstant)),
    maxCatchUpMs: ctx.tuning.maxFeedCatchUpMs,
  });
}

function locationsFeed(req: SimRequest, ctx: VendorContext): SimResponse {
  const ms = machines(ctx);
  const win = windowFor(req, ctx, ctx.tuning.gpsIntervalMs, ms.length);
  if ('kind' in win) return win;
  const silent = settingsOf(ctx).silent;
  const data = silent
    ? []
    : ms.flatMap((m) => {
        const locations = win.instants.flatMap((t) => {
          const s = sample(ctx, m, t);
          return s
            ? [
                {
                  time: new Date(t).toISOString(),
                  latitude: round(s.lat, 6),
                  longitude: round(s.lng, 6),
                  heading: round(s.heading, 1),
                  speed: round(Math.max(0, s.speedMph), 1),
                },
              ]
            : [];
        });
        return locations.length ? [{ id: m.telematics?.id ?? '', name: m.unitNo, locations }] : [];
      });
  return json(200, {
    data,
    pagination: { endCursor: encodeFeedCursor(win.endMs), hasNextPage: win.hasNextPage },
  });
}

/** The value of one stat type for one sample, or undefined when the gateway doesn't send it. */
function statValue(
  type: SamsaraEquipmentStatType,
  s: SimMachineSample,
  settings: SamsaraEquipmentSettings,
): unknown {
  switch (type) {
    case 'gps':
      return {
        latitude: round(s.lat, 6),
        longitude: round(s.lng, 6),
        headingDegrees: round(s.heading, 1),
        speedMilesPerHour: round(Math.max(0, s.speedMph), 1),
      };
    case 'fuelPercents':
      return Math.round(s.fuelPct);
    case 'engineRpm':
      return s.engineOn ? 1800 : 0;
    case 'obdEngineSeconds':
      return settings.hoursFrom.includes('obd') ? Math.round(s.engineHours * 3600) : undefined;
    case 'gatewayEngineSeconds':
      return settings.hoursFrom.includes('gateway')
        ? Math.round((s.engineHours + GATEWAY_DRIFT_H) * 3600)
        : undefined;
    case 'gatewayJ1939EngineSeconds':
      return settings.hoursFrom.includes('j1939')
        ? Math.round((s.engineHours + J1939_OFFSET_H) * 3600)
        : undefined;
    case 'obdEngineStates':
      return s.engineOn ? (s.speedMph < 0.5 ? 'Idle' : 'On') : 'Off';
    case 'gatewayEngineStates':
      return s.engineOn ? 'On' : 'Off';
    case 'gpsOdometerMeters':
      return Math.round(s.odometerMi * 1609.344);
    case 'engineTotalIdleTimeMinutes':
      return undefined; // Beta; not simulated
  }
}

function statsFeed(req: SimRequest, ctx: VendorContext): SimResponse {
  const raw = req.url.searchParams.get('types');
  if (!raw) return samsaraError(400, 'Missing required parameter: types');
  const types = [
    ...new Set(
      raw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
  if (types.length > SAMSARA_EQUIPMENT_MAX_TYPES) {
    return samsaraError(400, `At most ${SAMSARA_EQUIPMENT_MAX_TYPES} stat types may be requested`);
  }
  const unknown = types.filter(
    (t) => !(SAMSARA_EQUIPMENT_STAT_TYPES as readonly string[]).includes(t),
  );
  if (unknown.length) return samsaraError(400, `Unsupported stat types: ${unknown.join(',')}`);
  const ms = machines(ctx);
  const win = windowFor(req, ctx, ctx.tuning.statsIntervalMs, ms.length * types.length);
  if ('kind' in win) return win;
  const settings = settingsOf(ctx);
  const data = settings.silent
    ? []
    : ms.flatMap((m) => {
        const row: Record<string, unknown> = { id: m.telematics?.id ?? '', name: m.unitNo };
        let any = false;
        for (const t of win.instants) {
          const s = sample(ctx, m, t);
          if (!s) continue;
          for (const type of types as SamsaraEquipmentStatType[]) {
            const value = statValue(type, s, settings);
            if (value === undefined) continue;
            const time = new Date(t).toISOString();
            const event =
              type === 'gps' ? { time, ...(value as object) } : { time, value: value as unknown };
            const list = (row[type] as unknown[] | undefined) ?? [];
            list.push(event);
            row[type] = list;
            any = true;
          }
        }
        return any ? [row] : [];
      });
  return json(200, {
    data,
    pagination: { endCursor: encodeFeedCursor(win.endMs), hasNextPage: win.hasNextPage },
  });
}

export const samsaraEquipmentModule: SamsaraRouteModule = {
  key: 'equipment',
  route(req, ctx) {
    if (!req.path.startsWith('/fleet/equipment/')) return null;
    if (req.method !== 'GET') return samsaraError(405, 'Method not allowed');
    const limited = rateLimited(ctx, req.path);
    if (limited) return limited;
    switch (req.path) {
      case '/fleet/equipment/locations/feed':
        return locationsFeed(req, ctx);
      case '/fleet/equipment/stats/feed':
        return statsFeed(req, ctx);
      default:
        return null;
    }
  },
  control(req, ctx) {
    if (req.path !== '/settings') return null;
    if (req.method === 'GET') return json(200, settingsOf(ctx));
    if (req.method !== 'POST') return json(405, { error: 'GET or POST' });
    let body: unknown;
    try {
      body = req.body ? JSON.parse(req.body) : {};
    } catch {
      return json(400, { error: 'body must be JSON' });
    }
    const r = samsaraEquipmentSettingsRequestSchema.safeParse(body);
    if (!r.success) return json(400, { error: firstIssue(r.error) });
    const bag = samsaraModuleState(ctx, 'equipment');
    if (r.data.hoursFrom) bag.hoursFrom = [...new Set(r.data.hoursFrom)];
    if (r.data.silent !== undefined) bag.silent = r.data.silent;
    ctx.persist();
    ctx.log(`samsara equipment: ${JSON.stringify(settingsOf(ctx))}`);
    return json(200, settingsOf(ctx));
  },
};
