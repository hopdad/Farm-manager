/**
 * Samsara stand-in (mounted at /samsara): the cursor feeds the fleet.trucks job polls, computed
 * from the simulated world (contracts §9: sample `machineAt(id, simAt(wall))`, stamp `wall`).
 *
 *   GET /fleet/vehicles/locations/feed?after=&vehicleIds=
 *   GET /fleet/vehicles/stats/feed?types=obdEngineSeconds,fuelPercents,obdOdometerMeters&after=
 *   GET /fleet/vehicles/stats/feed?types=faultCodes&after=      (1f, fleet-faults: ./fault-codes.ts)
 *   Authorization: Bearer SIM_CREDENTIALS.samsara.apiToken
 *
 * faultCodes (slice 1f): a reading per vehicle whenever its active set changes (detected on a
 * 5 s wall grid), the first call (no cursor) the latest reading of every vehicle that reports
 * faults; the codes come from the knob (`/_control/vendor/samsara/fault-codes`, the core's own
 * control path next to the route modules' dispatch) or the scenario's schedule (breakdown: S3).
 * It may share a call with the stat types (Samsara allows any 3 types); those then report on
 * their own 60 s grid within the window.
 *
 * Shapes are typed by the shared zod schemas (src/connectors/samsara/schemas.ts). Vehicles are
 * the SimFarm machines on Samsara's vehicle feeds (`simTelematicsMachines(farm, 'samsara',
 * { feed: 'vehicle' })`: the semis and, 1f.2, the two pickups), named by unit number.
 *
 * 1f.2 (docs/contracts-1f.md part B):
 *  - Carmaker-cloud vehicles (`telematics.via` ford_pro / stellantis) report positions on their
 *    own sparser grid (`reportEverySeconds`), and the stats their route doesn't report
 *    (`statsNotReported`, src/connectors/vendors.ts) are left out (never sent as 0).
 *  - Route modules (./modules.ts, created empty) answer first: `equipment` (the machines builder:
 *    /fleet/equipment/* feeds for asset gateways) and `vehicles` (terminal-pickups: the vehicle
 *    list with tags); the first non-null reply wins, then the routes below.
 */
import { randomUUID } from 'node:crypto';
import {
  SAMSARA_FAULT_TYPE,
  SAMSARA_STAT_TYPES,
  type SamsaraFaultCodesFeed,
  type SamsaraLocation,
  type SamsaraLocationsFeed,
  type SamsaraStatsFeed,
  type SamsaraStatType,
  type SamsaraVehicleStats,
} from '../../../connectors/samsara/schemas';
import type { VehicleStatField } from '../../../connectors/types';
import { statsNotReported } from '../../../connectors/vendors';
import {
  SIM_CREDENTIALS,
  type SimMachine,
  type SimMachineSample,
  simTelematicsMachines,
} from '../../types';
import type { VendorContext, VendorControlContext, VendorModule } from '../context';
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
import { type SamsaraSimFaultsStatus, samsaraSimFaultsRequestSchema } from './control-types';
import {
  activeFaults,
  BREAKDOWN_SEMI_FAULT,
  FAULT_GRID_MS,
  faultReading,
  faultsKey,
  faultVehicles,
  readFaultsState,
  SAMSARA_FAULTS_STATE_KEY,
  withFaultChange,
} from './fault-codes';
import { SAMSARA_ROUTE_MODULES } from './modules';

interface FeedVehicle {
  id: string;
  name: string;
  machineId: string;
  /** Wall ms between this vehicle's position reports (null = every grid instant). */
  everyMs: number | null;
  /** Stats its route doesn't report (left out of the stats feed). */
  notReported: readonly VehicleStatField[];
}

const STAT_FIELD: Record<SamsaraStatType, VehicleStatField> = {
  obdEngineSeconds: 'engineHours',
  fuelPercents: 'fuelPct',
  obdOdometerMeters: 'odometerMi',
};

function feedVehicle(m: SimMachine): FeedVehicle {
  const t = m.telematics;
  return {
    id: t?.id ?? '',
    name: m.unitNo,
    machineId: m.id,
    everyMs: t?.reportEverySeconds ? t.reportEverySeconds * 1000 : null,
    notReported: t?.via ? statsNotReported('samsara', t.via) : [],
  };
}

function samsaraError(status: number, message: string, headers: Record<string, string> = {}) {
  return json(status, { message, requestId: randomUUID() }, headers);
}

/** The machines on Samsara's vehicle feeds, optionally filtered by `vehicleIds=a,b`. */
function vehicles(ctx: VendorContext, url: URL): FeedVehicle[] {
  const all = simTelematicsMachines(ctx.world.farm, 'samsara', { feed: 'vehicle' }).map(
    feedVehicle,
  );
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
  const first = !req.url.searchParams.get('after');
  for (const v of vs) {
    const locations: SamsaraLocation[] = [];
    for (const t of reportInstants(v, win.instants, first)) {
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

/**
 * The window's instants this vehicle reports at: every one, or (a sparse vehicle) those on its own
 * grid; the first call (no cursor) answers its latest report, like every other vehicle's.
 */
function reportInstants(v: FeedVehicle, instants: readonly number[], first: boolean): number[] {
  const every = v.everyMs;
  if (!every) return [...instants];
  if (first) {
    const last = instants[instants.length - 1];
    return last === undefined ? [] : [Math.floor(last / every) * every];
  }
  return instants.filter((t) => t % every === 0);
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
  const known: readonly string[] = [...SAMSARA_STAT_TYPES, SAMSARA_FAULT_TYPE];
  const unknown = types.filter((t) => !known.includes(t));
  if (unknown.length) return samsaraError(400, `Unsupported stat types: ${unknown.join(',')}`);
  const withFaults = types.includes(SAMSARA_FAULT_TYPE);
  const statTypes = types.filter((t): t is SamsaraStatType => t !== SAMSARA_FAULT_TYPE);
  const key = `samsara:stats:${types.join(',')}:${req.url.searchParams.get('vehicleIds') ?? ''}`;
  const dup = duplicateOf(req, ctx, key);
  if (dup) return dup;
  const vs = vehicles(ctx, req.url);
  const faulty = withFaults ? faultVehicles(ctx.world, req.url.searchParams.get('vehicleIds')) : [];
  const interval = withFaults ? FAULT_GRID_MS : ctx.tuning.statsIntervalMs;
  const win = windowFor(req, ctx, interval, Math.max(1, vs.length * types.length));
  if ('kind' in win) return win;
  const first = !req.url.searchParams.get('after');
  // With faultCodes in the call the window is on the 5 s fault grid; the stat types keep their
  // own grid within it (and the first call's single instant).
  const statInstants = withFaults
    ? win.instants.filter((t) => first || t % ctx.tuning.statsIntervalMs === 0)
    : win.instants;
  const rows = new Map<string, SamsaraVehicleStats & { faultCodes?: unknown[] }>();
  const rowOf = (id: string, name: string) => {
    let row = rows.get(id);
    if (!row) {
      row = { id, name };
      rows.set(id, row);
    }
    return row;
  };
  for (const v of vs) {
    const sent = statTypes.filter((type) => !v.notReported.includes(STAT_FIELD[type]));
    if (!sent.length) continue;
    for (const t of statInstants) {
      const s = sample(ctx, v.machineId, t);
      if (!s) continue;
      const row = rowOf(v.id, v.name);
      for (const type of sent) {
        const list = row[type] ?? [];
        list.push({ time: new Date(t).toISOString(), value: statValue(type, s) });
        row[type] = list;
      }
    }
  }
  if (withFaults) {
    const state = readFaultsState(ctx.state);
    const simAt = (w: Date) => ctx.simAt(w);
    for (const v of faulty) {
      for (const t of win.instants) {
        const now = activeFaults(ctx.world, state, v, t, simAt);
        // A reading whenever the set changes (and the latest one on the first call).
        if (!first) {
          const before = activeFaults(ctx.world, state, v, t - FAULT_GRID_MS, simAt);
          if (faultsKey(before.codes) === faultsKey(now.codes)) continue;
        }
        const row = rowOf(v.id, v.name);
        row.faultCodes = [...(row.faultCodes ?? []), faultReading(v, now.codes, t)];
      }
    }
  }
  let data = [...rows.values()];
  if (withFaults && firstOfKind(ctx.faults, 'out_of_order')) {
    ctx.counters.faults.out_of_order = (ctx.counters.faults.out_of_order ?? 0) + 1;
    data = seededShuffle(data, req.seq);
  }
  const body: SamsaraStatsFeed | SamsaraFaultCodesFeed = {
    data: data as SamsaraStatsFeed['data'],
    pagination: { endCursor: encodeFeedCursor(win.endMs), hasNextPage: win.hasNextPage },
  };
  ctx.lastPages.set(key, { after: req.url.searchParams.get('after'), body });
  return json(200, body);
}

// ---- the fault-code knob (/_control/vendor/samsara/fault-codes) ---------------------------

function faultsStatus(ctx: VendorControlContext): SamsaraSimFaultsStatus {
  const nowMs = ctx.now().getTime();
  const state = readFaultsState(ctx.state);
  const simAt = (w: Date) => ctx.simAt(w);
  const scheduled = faultVehicles(ctx.world).find((v) => v.name === BREAKDOWN_SEMI_FAULT.unitNo);
  return {
    scenario: ctx.world.scenario,
    simNow: ctx.simAt(new Date(nowMs)).toISOString(),
    vehicles: faultVehicles(ctx.world).map((v) => {
      const a = activeFaults(ctx.world, state, v, nowMs, simAt);
      return { id: v.id, name: v.name, codes: a.codes, from: a.from, setAt: a.setAt };
    }),
    schedule:
      ctx.world.scenario === 'breakdown' && scheduled
        ? {
            vehicle: scheduled.name,
            simAt: new Date(
              ctx.world.startsAt.getTime() + BREAKDOWN_SEMI_FAULT.afterStartMs,
            ).toISOString(),
            codes: [...BREAKDOWN_SEMI_FAULT.codes],
          }
        : null,
  };
}

function faultCodesControl(req: SimRequest, ctx: VendorControlContext): SimResponse {
  if (req.method === 'GET') return json(200, faultsStatus(ctx));
  if (req.method !== 'POST') {
    return json(405, { error: `${req.method} not allowed on /fault-codes` });
  }
  let value: unknown;
  try {
    value = req.body ? JSON.parse(req.body) : {};
  } catch {
    return json(400, { error: 'body must be JSON' });
  }
  const parsed = samsaraSimFaultsRequestSchema.safeParse(value);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return json(400, {
      error: i ? `${i.path.join('.') || '(body)'}: ${i.message}` : 'bad request',
    });
  }
  const { vehicle, codes } = parsed.data;
  const v = faultVehicles(ctx.world).find((x) => x.id === vehicle || x.name === vehicle);
  if (!v) return json(404, { error: `no Samsara vehicle '${vehicle}' reports fault codes` });
  const next = withFaultChange(readFaultsState(ctx.state), v.id, ctx.now(), codes);
  ctx.state.vendors = { ...(ctx.state.vendors ?? {}), [SAMSARA_FAULTS_STATE_KEY]: next };
  ctx.persist();
  ctx.log(
    `samsara fault codes: ${v.name} ${codes === null ? 'back to the scenario' : codes.length ? codes.map((c) => (c.system === 'j1939' ? `SPN ${c.spn} FMI ${c.fmi}` : c.system === 'obd2' ? c.dtc : c.code)).join(', ') : 'cleared'}`,
  );
  return json(200, faultsStatus(ctx));
}

export const samsaraModule: VendorModule = {
  vendor: 'samsara',
  error: samsaraError,
  async handle(req, ctx) {
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
    for (const mod of SAMSARA_ROUTE_MODULES) {
      const reply = await mod.route(req, ctx);
      if (reply) return reply;
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
  /**
   * /_control/vendor/samsara/fault-codes → the core's fault-code knob (1f, fleet-faults);
   * /_control/vendor/samsara/<key>/... → that route module's control() (./modules.ts).
   */
  async control(req, ctx) {
    if ((req.path.replace(/\/+$/, '') || '/') === '/fault-codes')
      return faultCodesControl(req, ctx);
    const [, key = '', ...rest] = req.path.split('/');
    const mod = SAMSARA_ROUTE_MODULES.find((m) => m.key === key);
    const hit = mod?.control
      ? await mod.control({ ...req, path: `/${rest.join('/')}` }, ctx)
      : null;
    return hit ?? json(404, { error: `no Samsara control at ${req.path}` });
  },
};
