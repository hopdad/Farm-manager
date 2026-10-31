/**
 * Terminal stand-in (mounted at /terminal; slice 1f.2, the terminal-pickups builder,
 * docs/contracts-1f.md part B §B.7): Terminal's normalized API under /terminal/tsp/v1, in the
 * shapes of its OpenAPI 3.1 (api.withterminal.com/tsp/openapi; the zod schemas in
 * src/connectors/terminal/schemas.ts type both sides):
 *
 *   GET /providers                                no key needed: ./catalog.ts
 *   GET /connections?status=                      Bearer <secret key> alone; each row its `token`
 *   GET /connections/current                      + Connection-Token
 *   GET /vehicles?expand=groups                   + Connection-Token (the hauler's vehicles)
 *   GET /vehicles/locations?vehicleIds=           latest: the provider's real-time last fix
 *                                                 (≤ 50 ids; odometer km, engine state, runtime ms)
 *   GET /vehicles/{id}/locations?startAt=&endAt=  history (Terminal's sync: stored
 *                                                 TERMINAL_SIM_SYNC_LAG_SECONDS after the fact)
 *   GET /vehicles/{id}/stats/historical?types=&startAt=&endAt=
 *   GET /fault-codes/events?modifiedAfter=&vehicleIds=
 *   Authorization: Bearer SIM_CREDENTIALS.terminal.secretKey
 *   Connection-Token: SIM_CREDENTIALS.terminal.connectionToken (the hauler's connection)
 *
 * Lists answer `{ results, next? }` (`cursor` / `limit`, default 100); units are metric (km,
 * km/h, ms). The vehicles are `simTelematicsMachines(farm, 'terminal')` (the hired hauler H3:
 * connection SIM_TERMINAL_CONNECTION_ID, TSP `omnitracs-xrs`), sampled with
 * `world.machineAt(id, simAt(t))` at wall instants `t` on a TERMINAL_SIM_REPORT_EVERY_SECONDS
 * grid and stamped `t` (no jitter: a paused simulation keeps H3 fresh and still, the M0 demo). A
 * record is "stored" (listed by history, stat logs and fault events, its `metadata.modifiedAt`)
 * TERMINAL_SIM_SYNC_LAG_SECONDS after its record time, unless the sync knob stalled it; latest
 * locations never lag. The stand-in keeps TERMINAL_SIM_HISTORY_MS of history (Terminal keeps
 * months). It also lists a second, disconnected connection (a hauler who left).
 *
 * Errors are Terminal's own flat body, `{ code, message, detail? }` (`unauthorized`,
 * `not_found`, `bad_request`, `connection_disconnected`, `too_many_requests` with a possibly
 * fractional Retry-After). Knobs: ./control-types.ts.
 */
import type {
  TerminalConnection,
  TerminalFaultEvent,
  TerminalHistoricalLocation,
  TerminalLatestLocation,
  TerminalStatLog,
  TerminalVehicle,
} from '../../../connectors/terminal/schemas';
import { hash32 } from '../../rng';
import {
  SIM_CREDENTIALS,
  SIM_TERMINAL_CONNECTION_ID,
  type SimMachine,
  type SimMachineSample,
  simTelematicsMachines,
} from '../../types';
import type { VendorContext, VendorControlContext, VendorModule } from '../context';
import { round } from '../feed';
import { bearerToken, header, json, type SimRequest, type SimResponse } from '../http';
import { SIM_TERMINAL_PROVIDERS, simProviderName, simProviderStatTypes } from './catalog';
import {
  EMPTY_TERMINAL_SIM_STATE,
  SIM_TERMINAL_GONE_CONNECTION_ID,
  SIM_TERMINAL_GONE_CONNECTION_TOKEN,
  TERMINAL_SIM_FAULT_CODE,
  TERMINAL_SIM_HISTORY_MS,
  TERMINAL_SIM_REPORT_EVERY_SECONDS,
  TERMINAL_SIM_STATS_EVERY_SECONDS,
  TERMINAL_SIM_SYNC_LAG_SECONDS,
  type TerminalSimFaultEvent,
  type TerminalSimState,
  type TerminalSimStatus,
  terminalSimConnectionRequestSchema,
  terminalSimFaultRequestSchema,
  terminalSimRateLimitRequestSchema,
  terminalSimStateSchema,
  terminalSimSyncRequestSchema,
} from './control-types';

const BASE = '/tsp/v1';
const KMH_PER_MPH = 1.609344;
const KM_PER_MI = 1.609344;
const MAX_IDS = 50;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
/** When the demo hauler linked its account (fixed, so replies are stable). */
const LINKED_AT = '2026-09-01T12:00:00.000Z';

const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  422: 'unprocessable_entity',
  429: 'too_many_requests',
};

/** Terminal's error body: `{ code, message, detail? }` (`code` defaults by status). */
export function terminalError(
  status: number,
  message: string,
  headers: Record<string, string> = {},
  detail?: string,
  code?: string,
) {
  return json(
    status,
    {
      code: code ?? CODES[status] ?? 'internal_server_error',
      message,
      ...(detail ? { detail } : {}),
    },
    headers,
  );
}

// ---- state ------------------------------------------------------------------------------------

function readState(ctx: { state: { vendors?: Record<string, Record<string, unknown>> } }) {
  const r = terminalSimStateSchema.safeParse(ctx.state.vendors?.terminal);
  return r.success ? r.data : structuredClone(EMPTY_TERMINAL_SIM_STATE);
}

function writeState(
  ctx: { state: VendorContext['state']; persist(): void },
  next: TerminalSimState,
) {
  ctx.state.vendors = { ...(ctx.state.vendors ?? {}), terminal: { ...next } };
  ctx.persist();
}

// ---- the world's Terminal vehicles and connections ---------------------------------------------

interface SimVehicle {
  machine: SimMachine;
  id: string;
  connectionId: string;
  provider: string;
}

interface SimConnection {
  id: string;
  token: string;
  provider: string;
  status: 'connected' | 'disconnected';
  vehicles: SimVehicle[];
}

function vehiclesOf(ctx: { world: VendorContext['world'] }): SimVehicle[] {
  return simTelematicsMachines(ctx.world.farm, 'terminal').map((m) => ({
    machine: m,
    id: m.telematics?.id ?? '',
    connectionId: m.telematics?.provider ?? SIM_TERMINAL_CONNECTION_ID,
    provider: m.telematics?.tsp ?? 'omnitracs-xrs',
  }));
}

function connectionsOf(
  ctx: { world: VendorContext['world'] },
  s: TerminalSimState,
): SimConnection[] {
  const byId = new Map<string, SimConnection>();
  for (const v of vehiclesOf(ctx)) {
    const c = byId.get(v.connectionId) ?? {
      id: v.connectionId,
      token:
        v.connectionId === SIM_TERMINAL_CONNECTION_ID
          ? SIM_CREDENTIALS.terminal.connectionToken
          : `sim-terminal-${v.connectionId}`,
      provider: v.provider,
      status: s.connections[v.connectionId] ?? 'connected',
      vehicles: [],
    };
    c.vehicles.push(v);
    byId.set(c.id, c);
  }
  return [
    ...byId.values(),
    {
      id: SIM_TERMINAL_GONE_CONNECTION_ID,
      token: SIM_TERMINAL_GONE_CONNECTION_TOKEN,
      provider: 'people-net',
      status: 'disconnected',
      vehicles: [],
    },
  ];
}

function connectionBody(c: SimConnection): TerminalConnection {
  const gone = c.id === SIM_TERMINAL_GONE_CONNECTION_ID;
  const name = gone ? 'Former Hauler Inc.' : 'Sim Hauling LLC';
  return {
    id: c.id,
    company: { name, dotNumbers: [] },
    account: { name, dotNumbers: [] },
    provider: { code: c.provider, name: simProviderName(c.provider) },
    syncMode: 'automatic',
    token: c.token,
    tags: [],
    status: c.status,
    options: { ingestHistoryFromSourceSystem: true },
    linkUrl: `https://link.withterminal.com/connection/${c.id}?key=pk_sandbox_sim`,
    createdAt: LINKED_AT,
    updatedAt: LINKED_AT,
  };
}

// ---- time: the report grid, Terminal's sync lag and the stall knob ----------------------------

const grid = (seconds: number) => seconds * 1000;
const floorTo = (t: number, step: number) => Math.floor(t / step) * step;
const ceilTo = (t: number, step: number) => Math.ceil(t / step) * step;
const isoAt = (t: number) => new Date(t).toISOString();

/** When Terminal stored a record of time `t` (null: not yet, the sync is stalled). */
export function terminalStoredAt(s: TerminalSimState, t: number): number | null {
  const at = t + TERMINAL_SIM_SYNC_LAG_SECONDS * 1000;
  const stalled = s.stalledAt ? Date.parse(s.stalledAt) : null;
  if (stalled !== null && at > stalled) {
    const resumed = s.resumedAt ? Date.parse(s.resumedAt) : null;
    if (resumed === null) return null;
    if (at <= resumed) return resumed;
  }
  return at;
}

function sample(ctx: VendorContext, m: SimMachine, t: number): SimMachineSample | null {
  return ctx.world.machineAt(m.id, ctx.simAt(new Date(t)));
}

function timeParam(req: SimRequest, name: string): number | null | 'bad' {
  const v = req.url.searchParams.get(name);
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 'bad' : t;
}

/** Record instants in [startAt, endAt] on `step`, within the history the stand-in keeps. */
function instants(ctx: VendorContext, req: SimRequest, step: number): number[] | SimResponse {
  const start = timeParam(req, 'startAt');
  const end = timeParam(req, 'endAt');
  if (start === 'bad' || end === 'bad') {
    return terminalError(400, 'Invalid request', {}, 'startAt and endAt must be ISO 8601 dates');
  }
  const now = ctx.now().getTime();
  const from = ceilTo(Math.max(start ?? 0, now - TERMINAL_SIM_HISTORY_MS), step);
  const to = floorTo(Math.min(end ?? now, now), step);
  const out: number[] = [];
  for (let t = from; t <= to; t += step) out.push(t);
  return out;
}

// ---- paging -----------------------------------------------------------------------------------

function page<T>(req: SimRequest, all: T[]): SimResponse {
  const raw = req.url.searchParams.get('limit');
  const limit = raw ? Number(raw) : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return terminalError(400, 'Invalid request', {}, `limit must be an integer 1-${MAX_LIMIT}`);
  }
  const cursor = req.url.searchParams.get('cursor');
  let offset = 0;
  if (cursor) {
    const n = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Number.isInteger(n) || n < 0) {
      return terminalError(400, 'Invalid request', {}, 'bad cursor');
    }
    offset = n;
  }
  const results = all.slice(offset, offset + limit);
  const more = offset + limit < all.length;
  return json(200, {
    results,
    ...(more ? { next: Buffer.from(String(offset + limit)).toString('base64url') } : {}),
  });
}

function idsParam(req: SimRequest, name: string): string[] | null | SimResponse {
  const v = req.url.searchParams.get(name);
  if (!v) return null;
  const list = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length > MAX_IDS) {
    return terminalError(400, 'Invalid request', {}, `${name}: at most ${MAX_IDS} ids`);
  }
  return list;
}

const isResponse = (v: unknown): v is SimResponse =>
  !!v && typeof v === 'object' && !Array.isArray(v) && 'kind' in v;

// ---- data -------------------------------------------------------------------------------------

/** Stable, time-ordered ids (ULID-like: time first). */
const timeId = (prefix: string, t: number, ...parts: (string | number)[]) =>
  `${prefix}${t.toString(36).toUpperCase().padStart(10, '0')}${hash32(prefix, t, ...parts)
    .toString(36)
    .toUpperCase()
    .padStart(7, '0')}`;

const groupId = (name: string) =>
  `group_${hash32('sim-terminal-group', name).toString(36).toUpperCase()}`;

function engineState(x: SimMachineSample): 'on' | 'off' | 'idle' {
  if (!x.engineOn) return 'off';
  return x.speedMph < 1 ? 'idle' : 'on';
}

function vehicleBody(v: SimVehicle, expand: boolean): TerminalVehicle {
  const m = v.machine;
  const names = m.telematics?.tags?.length ? m.telematics.tags : ['Hired trucks'];
  return {
    id: v.id,
    sourceId: String(100_000 + (hash32('sim-terminal-source', v.id) % 900_000)),
    provider: v.provider,
    status: 'active',
    name: m.unitNo,
    make: m.make,
    model: m.model.replace(/ \+ .*$/, ''),
    year: m.year,
    groups: names.map((name) =>
      expand
        ? {
            id: groupId(name),
            sourceId: String(hash32('sim-terminal-group-source', name) % 100_000),
            provider: v.provider,
            name,
            metadata: { addedAt: LINKED_AT, modifiedAt: LINKED_AT, visibility: 'visible' },
          }
        : groupId(name),
    ),
    metadata: { addedAt: LINKED_AT, modifiedAt: LINKED_AT, deletedAt: null, visibility: 'visible' },
  };
}

function latestBody(ctx: VendorContext, v: SimVehicle): TerminalLatestLocation | null {
  const t = floorTo(ctx.now().getTime(), grid(TERMINAL_SIM_REPORT_EVERY_SECONDS));
  const x = sample(ctx, v.machine, t);
  if (!x) return null;
  const types = new Set(simProviderStatTypes(v.provider));
  return {
    provider: v.provider,
    vehicle: v.id,
    locatedAt: isoAt(t),
    location: { longitude: round(x.lng, 7), latitude: round(x.lat, 7) },
    heading: round(x.heading, 1),
    speed: round(Math.max(0, x.speedMph) * KMH_PER_MPH, 2),
    ...(types.has('odometer') ? { odometer: round(x.odometerMi * KM_PER_MI, 2) } : {}),
    ...(types.has('fuel_level') ? { fuel: { primaryPercentage: round(x.fuelPct, 1) } } : {}),
    ...(types.has('engine_state') ? { engineState: engineState(x) } : {}),
    ...(types.has('engine_runtime')
      ? { engineRuntime: Math.round(x.engineHours * 3_600_000) }
      : {}),
  };
}

function historyBody(
  ctx: VendorContext,
  s: TerminalSimState,
  v: SimVehicle,
  times: number[],
): TerminalHistoricalLocation[] {
  const now = ctx.now().getTime();
  const out: TerminalHistoricalLocation[] = [];
  for (const t of times) {
    const at = terminalStoredAt(s, t);
    if (at === null || at > now) continue;
    const x = sample(ctx, v.machine, t);
    if (!x) continue;
    out.push({
      id: timeId('vcl_loc_', t, v.id),
      sourceId: String(t / 1000),
      provider: v.provider,
      vehicle: v.id,
      locatedAt: isoAt(t),
      location: { longitude: round(x.lng, 7), latitude: round(x.lat, 7) },
      heading: round(x.heading, 1),
      speed: round(Math.max(0, x.speedMph) * KMH_PER_MPH, 2),
      metadata: { modifiedAt: isoAt(at) },
    });
  }
  return out;
}

const STAT_TYPES_SERVED = ['engine_state', 'odometer', 'engine_runtime', 'fuel_level'] as const;

function statsBody(
  ctx: VendorContext,
  s: TerminalSimState,
  v: SimVehicle,
  times: number[],
  requested: string[] | null,
): TerminalStatLog[] {
  const now = ctx.now().getTime();
  const supported = new Set(simProviderStatTypes(v.provider));
  const types = STAT_TYPES_SERVED.filter(
    (type) => supported.has(type) && (!requested || requested.includes(type)),
  );
  const out: TerminalStatLog[] = [];
  for (const t of times) {
    const at = terminalStoredAt(s, t);
    if (at === null || at > now) continue;
    const x = sample(ctx, v.machine, t);
    if (!x) continue;
    for (const type of types) {
      const base = {
        id: timeId('vcl_st_', t, v.id, type),
        sourceId: `${t / 1000}:${type}`,
        provider: v.provider,
        type,
        timestamp: isoAt(t),
        vehicle: v.id,
        metadata: { modifiedAt: isoAt(at) },
      };
      switch (type) {
        case 'engine_state':
          out.push({ ...base, state: engineState(x) });
          break;
        case 'odometer':
          out.push({ ...base, odometer: round(x.odometerMi * KM_PER_MI, 2) });
          break;
        case 'engine_runtime':
          out.push({ ...base, duration: Math.round(x.engineHours * 3_600_000) });
          break;
        case 'fuel_level':
          out.push({ ...base, fuelPercentage: round(x.fuelPct, 1) });
          break;
      }
    }
  }
  return out;
}

function faultBody(
  e: TerminalSimFaultEvent,
  provider: string,
  modifiedAt: number,
): TerminalFaultEvent {
  const base = {
    id: e.id,
    provider,
    vehicle: e.vehicleId,
    status: e.status,
    observedAt: e.observedAt,
    metadata: { addedAt: isoAt(modifiedAt), modifiedAt: isoAt(modifiedAt) },
    code: TERMINAL_SIM_FAULT_CODE[e.kind],
  };
  switch (e.kind) {
    case 'j1939':
      return {
        ...base,
        protocol: 'j1939',
        description:
          'Engine Coolant Temperature - Data Valid But Above Normal Operational Range - Most Severe Level',
        milStatus: 'on',
        j1939: {
          spn: 110,
          fmi: 0,
          spnDescription: 'Engine Coolant Temperature',
          fmiDescription: 'Data Valid But Above Normal Operational Range - Most Severe Level',
          occurrenceCount: 3,
          sourceAddress: 0,
        },
      };
    case 'obdii':
      return {
        ...base,
        protocol: 'obdii',
        description: 'Engine Coolant Over Temperature Condition',
        milStatus: 'on',
        obdii: { code: 'P0217', description: 'Engine Coolant Over Temperature Condition' },
      };
    case 'j1939_no_fmi':
      return {
        ...base,
        protocol: 'j1939',
        description: 'Aftertreatment 1 SCR Intake Temperature',
        milStatus: 'off',
        j1939: { spn: 3031, spnDescription: 'Aftertreatment 1 SCR Intake Temperature' },
      };
    case 'j1939_bad_address':
      return {
        ...base,
        protocol: 'j1939',
        description: 'System Diagnostic Code #1 - Voltage Below Normal',
        milStatus: 'off',
        j1939: {
          spn: 3031,
          fmi: 9,
          spnDescription: 'System Diagnostic Code #1',
          fmiDescription: 'Voltage Below Normal',
          occurrenceCount: 15,
          sourceAddress: 256,
        },
      };
  }
}

// ---- routes -----------------------------------------------------------------------------------

function connectionOf(req: SimRequest, conns: SimConnection[]): SimConnection | SimResponse {
  const token = header(req.headers, 'connection-token')?.trim();
  if (!token) {
    return terminalError(
      401,
      'Unauthorized Request',
      {},
      'The Connection-Token header is required',
    );
  }
  const c = conns.find((x) => x.token === token);
  if (!c) return terminalError(401, 'Unauthorized Request', {}, 'Unknown connection token');
  if (c.status !== 'connected') {
    return terminalError(
      422,
      'Connection is disconnected',
      {},
      'Reconnect the account through Terminal Link',
      'connection_disconnected',
    );
  }
  return c;
}

function faultEvents(
  req: SimRequest,
  ctx: VendorContext,
  s: TerminalSimState,
  conn: SimConnection,
): SimResponse {
  const want = idsParam(req, 'vehicleIds');
  if (isResponse(want)) return want;
  const after = timeParam(req, 'modifiedAfter');
  const start = timeParam(req, 'startAt');
  const end = timeParam(req, 'endAt');
  if (after === 'bad' || start === 'bad' || end === 'bad') {
    return terminalError(400, 'Invalid request', {}, 'dates must be ISO 8601');
  }
  const now = ctx.now().getTime();
  const mine = new Map(conn.vehicles.map((v) => [v.id, v]));
  const events = s.events
    .flatMap((e) => {
      const v = mine.get(e.vehicleId);
      if (!v || (want && !want.includes(e.vehicleId))) return [];
      const observed = Date.parse(e.observedAt);
      const at = terminalStoredAt(s, observed);
      if (at === null || at > now) return [];
      if (after !== null && at <= after) return [];
      if (start !== null && observed < start) return [];
      if (end !== null && observed > end) return [];
      return [{ at, body: faultBody(e, v.provider, at) }];
    })
    .sort((a, b) => a.at - b.at || a.body.id.localeCompare(b.body.id))
    .map((x) => x.body);
  return page(req, events);
}

function route(req: SimRequest, ctx: VendorContext, sub: string): SimResponse {
  const s = readState(ctx);
  const conns = connectionsOf(ctx, s);
  if (sub === '/connections') {
    const status = req.url.searchParams.get('status');
    return page(req, conns.filter((c) => !status || c.status === status).map(connectionBody));
  }
  const conn = connectionOf(req, conns);
  if (isResponse(conn)) return conn;
  const vehicle = (id: string) => conn.vehicles.find((v) => v.id === id);

  if (sub === '/connections/current') return json(200, connectionBody(conn));
  if (sub === '/vehicles') {
    const expand = (req.url.searchParams.get('expand') ?? '').split(',').includes('groups');
    return page(
      req,
      conn.vehicles.map((v) => vehicleBody(v, expand)),
    );
  }
  if (sub === '/vehicles/locations') {
    const want = idsParam(req, 'vehicleIds');
    if (isResponse(want)) return want;
    const list = conn.vehicles.filter((v) => !want || want.includes(v.id));
    // Vehicles with no last known location are left out (Terminal's docs).
    return page(
      req,
      list.flatMap((v) => latestBody(ctx, v) ?? []),
    );
  }
  if (sub === '/fault-codes/events') return faultEvents(req, ctx, s, conn);
  const hist = /^\/vehicles\/([^/]+)\/locations$/.exec(sub);
  if (hist) {
    const v = vehicle(decodeURIComponent(hist[1] as string));
    if (!v) return terminalError(404, 'Not found', {}, 'No such vehicle on this connection');
    const times = instants(ctx, req, grid(TERMINAL_SIM_REPORT_EVERY_SECONDS));
    if (isResponse(times)) return times;
    return page(req, historyBody(ctx, s, v, times));
  }
  const stats = /^\/vehicles\/([^/]+)\/stats\/historical$/.exec(sub);
  if (stats) {
    const v = vehicle(decodeURIComponent(stats[1] as string));
    if (!v) return terminalError(404, 'Not found', {}, 'No such vehicle on this connection');
    const times = instants(ctx, req, grid(TERMINAL_SIM_STATS_EVERY_SECONDS));
    if (isResponse(times)) return times;
    const types = req.url.searchParams.get('types');
    return page(
      req,
      statsBody(ctx, s, v, times, types ? types.split(',').map((t) => t.trim()) : null),
    );
  }
  return terminalError(404, `Not found: ${req.path} (not simulated)`);
}

// ---- control ----------------------------------------------------------------------------------

function statusOf(ctx: { world: VendorContext['world'] }, s: TerminalSimState): TerminalSimStatus {
  return {
    connections: connectionsOf(ctx, s).map((c) => ({
      id: c.id,
      status: c.status,
      vehicles: c.vehicles.map((v) => v.id),
    })),
    vehicles: vehiclesOf(ctx).map((v) => ({
      id: v.id,
      unitNo: v.machine.unitNo,
      connectionId: v.connectionId,
      provider: v.provider,
    })),
    events: s.events,
    sync: { stalledAt: s.stalledAt, resumedAt: s.resumedAt },
    rateLimit: s.rateLimit,
  };
}

function parseBody(req: SimRequest): unknown {
  try {
    return req.body ? JSON.parse(req.body) : {};
  } catch {
    return undefined;
  }
}

const CONTROL_PATHS = ['/fault-codes', '/sync', '/connections', '/rate-limit'];

function changeFaults(
  ctx: VendorControlContext,
  s: TerminalSimState,
  body: unknown,
  now: string,
): string | null {
  const r = terminalSimFaultRequestSchema.safeParse(body);
  if (!r.success) return r.error.issues[0]?.message ?? 'bad request';
  const rq = r.data;
  const nextId = () => {
    const id = `fc_evt_SIM${String(s.nextEvent).padStart(8, '0')}`;
    s.nextEvent += 1;
    return id;
  };
  if (rq.action === 'clear') {
    s.events = [];
  } else if (rq.action === 'open') {
    const all = vehiclesOf(ctx);
    const v = rq.vehicleId ? all.find((x) => x.id === rq.vehicleId) : all[0];
    if (!v) return `no Terminal vehicle ${rq.vehicleId ?? ''}`.trim();
    s.events.push({
      id: nextId(),
      vehicleId: v.id,
      kind: rq.kind ?? 'j1939',
      status: rq.status ?? 'open',
      observedAt: now,
    });
  } else {
    const last = [...s.events].reverse().find((e) => TERMINAL_SIM_FAULT_CODE[e.kind] === rq.code);
    if (!last) return `no fault event with code ${rq.code}`;
    s.events.push({ ...last, id: nextId(), status: 'closed', observedAt: now });
  }
  return null;
}

function control(req: SimRequest, ctx: VendorControlContext): SimResponse {
  const s = readState(ctx);
  if (!CONTROL_PATHS.includes(req.path)) {
    return json(404, { error: `no Terminal control at ${req.path}` });
  }
  if (req.method === 'GET') return json(200, statusOf(ctx, s));
  if (req.method !== 'POST') return json(405, { error: `${req.method} not allowed` });
  const body = parseBody(req);
  const now = ctx.now().toISOString();
  let error: string | null = null;
  switch (req.path) {
    case '/fault-codes':
      error = changeFaults(ctx, s, body, now);
      break;
    case '/sync': {
      const r = terminalSimSyncRequestSchema.safeParse(body);
      if (!r.success) error = 'expected { stalled: boolean }';
      else if (r.data.stalled) {
        if (!s.stalledAt || s.resumedAt) s.stalledAt = now;
        s.resumedAt = null;
      } else if (s.stalledAt && !s.resumedAt) {
        s.resumedAt = now;
      }
      break;
    }
    case '/connections': {
      const r = terminalSimConnectionRequestSchema.safeParse(body);
      if (!r.success) error = 'expected { connectionId?, status }';
      else if (r.data.status === 'connected') delete s.connections[r.data.connectionId];
      else s.connections[r.data.connectionId] = 'disconnected';
      break;
    }
    case '/rate-limit': {
      const r = terminalSimRateLimitRequestSchema.safeParse(body);
      if (!r.success) error = 'expected { count, retryAfter? }';
      else s.rateLimit = { remaining: r.data.count, retryAfter: r.data.retryAfter ?? '0.62' };
      break;
    }
  }
  if (error) return json(400, { error });
  writeState(ctx, s);
  ctx.log(`terminal: ${req.path} changed`);
  return json(200, statusOf(ctx, s));
}

export const terminalModule: VendorModule = {
  vendor: 'terminal',
  error: (status, message, headers) => terminalError(status, message, headers),
  handle(req, ctx) {
    if (!req.path.startsWith(`${BASE}/`)) {
      return terminalError(404, `Not found: ${req.path} (not simulated)`);
    }
    const sub = req.path.slice(BASE.length);
    if (req.method !== 'GET') return terminalError(405, 'Method not allowed');
    // GET /providers answers with no key (Terminal's catalog is public).
    if (sub === '/providers') return json(200, SIM_TERMINAL_PROVIDERS);
    if (bearerToken(req.headers) !== SIM_CREDENTIALS.terminal.secretKey) {
      return terminalError(
        401,
        'Unauthorized Request',
        {},
        'Must authenticate with an application to perform this operation',
      );
    }
    const s = readState(ctx);
    if (s.rateLimit.remaining > 0) {
      writeState(ctx, {
        ...s,
        rateLimit: { ...s.rateLimit, remaining: s.rateLimit.remaining - 1 },
      });
      return json(
        429,
        {
          code: 'too_many_requests',
          retryAfter: Math.ceil(Number(s.rateLimit.retryAfter)),
          message: 'Too Many Requests',
          detail: 'Rate limit exceeded, please retry later',
        },
        { 'retry-after': s.rateLimit.retryAfter },
      );
    }
    return route(req, ctx, sub);
  },
  control,
};
