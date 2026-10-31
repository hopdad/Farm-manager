/**
 * MyGeotab stand-in (mounted at /geotab; slice 1f.2, the trucks builder, docs/contracts-1f.md
 * §B.7): JSON-RPC at POST /geotab/apiv1 for the Geotab vehicles of the demo world
 * (`simTelematicsMachines(farm, 'geotab')`: the hired hauler H2), in MyGeotab's documented
 * shapes (my.geotab.com/api.json; src/connectors/geotab/schemas.ts types both sides):
 *
 *   Authenticate { database, userName, password }   SIM_CREDENTIALS.geotab (`userName` on the
 *        wire); a session per call, at most 100 per user (the oldest ends), 10 a minute;
 *        LoginResult.path "ThisServer" (the knob: a host, or absent)
 *   GetFeed { typeName, fromVersion?, resultsLimit }  LogRecord (every 5 s grid instant, the
 *        gpsIntervalMs: no jitter), StatusData (every 60 s: engine hours in seconds, odometer
 *        in meters, fuel %, ignition, AND engine speed and coolant temperature: the feed returns
 *        every diagnostic), FaultData (the knob's records); one version counter per entity type,
 *        no fromVersion = "from now" (empty data + toVersion); 60 a minute per entity type
 *   Get { typeName, search }   Diagnostic / FailureMode (by ids), Device, Group, DeviceStatusInfo
 *        (the last known position; `search.diagnostics` adds their latest StatusData)
 *   GetVersion                 no credentials
 *
 * Errors are MyGeotab's own (api.json; live-checked): HTTP 200 with a JSON-RPC error object,
 * `{ error: { code, message, data: { id, type, requestIndex } }, jsonrpc: '2.0' }`, told apart by
 * `data.type`: InvalidUserException (bad login, an unknown or expired session),
 * OverLimitException (+ Retry-After), MissingMethodException; a limited-scope user's GetFeed on
 * LogRecord/StatusData answers an ArgumentException (MyGeotab 11.119; the real type is
 * unrecorded). Samples follow the time rule: `world.machineAt(id, simAt(wall))` stamped `wall`.
 * Control (./control-types.ts): fault records, the login path, the scope, session expiry.
 */
import { randomUUID } from 'node:crypto';
import type {
  GeotabDeviceStatusInfo,
  GeotabFeedResult,
  GeotabLoginResult,
  GeotabLogRecord,
  GeotabStatusData,
} from '../../../connectors/geotab/schemas';
import {
  SIM_CREDENTIALS,
  type SimMachine,
  type SimMachineSample,
  simTelematicsMachines,
} from '../../types';
import type { VendorContext, VendorControlContext, VendorModule } from '../context';
import { firstOfKind } from '../faults';
import { round } from '../feed';
import { header, json, type SimRequest, type SimResponse } from '../http';
import {
  GEOTAB_SIM_DIAGNOSTICS,
  GEOTAB_SIM_FAILURE_MODES,
  GEOTAB_SIM_FAULT_PRESETS,
  GEOTAB_SIM_GROUPS,
} from './catalog';
import {
  EMPTY_GEOTAB_SIM_STATE,
  type GeotabSimFault,
  type GeotabSimState,
  type GeotabSimStatus,
  geotabSimFaultRequestSchema,
  geotabSimServerRequestSchema,
  geotabSimStateSchema,
} from './control-types';

/** What GetVersion answers (live-checked on my.geotab.com, Oct 30, 2026). */
export const GEOTAB_SIM_VERSION = '11.149.665';
const KMH_PER_MPH = 1.609344;
const METERS_PER_MILE = 1609.344;
const MINUTE = 60_000;
const MAX_SESSIONS_PER_USER = 100;
const AUTHENTICATE_PER_MINUTE = 10;
const GETFEED_PER_MINUTE = 60;
const MAX_RESULTS = 50_000;

/** A MyGeotab JSON-RPC error (always HTTP 200; the client switches on `error.data.type`). */
export function geotabError(
  type: string,
  message: string,
  headers: Record<string, string> = {},
  status = 200,
) {
  return json(
    status,
    {
      error: { code: -32000, message, data: { id: randomUUID(), type, requestIndex: 0 } },
      jsonrpc: '2.0',
    },
    headers,
  );
}

function rpcResult(result: unknown, id: unknown) {
  return json(200, { result, jsonrpc: '2.0', ...(id === undefined ? {} : { id }) });
}

// ---- state ------------------------------------------------------------------------------------

function readState(ctx: { state: { vendors?: Record<string, Record<string, unknown>> } }) {
  const r = geotabSimStateSchema.safeParse(ctx.state.vendors?.geotab);
  return r.success ? r.data : structuredClone(EMPTY_GEOTAB_SIM_STATE);
}

function writeState(ctx: { state: VendorContext['state']; persist(): void }, next: GeotabSimState) {
  ctx.state.vendors = { ...(ctx.state.vendors ?? {}), geotab: { ...next } };
  ctx.persist();
}

/** In-memory counters and rate windows per stand-in state (a reset starts them over). */
interface Runtime {
  windows: Map<string, number[]>;
  calls: GeotabSimStatus['calls'];
}
const runtimes = new WeakMap<object, Runtime>();

function runtime(ctx: { state: object }): Runtime {
  let r = runtimes.get(ctx.state);
  if (!r) {
    r = {
      windows: new Map(),
      calls: { authenticate: 0, getFeed: {}, get: {}, overLimit: 0, hosts: {} },
    };
    runtimes.set(ctx.state, r);
  }
  return r;
}

/** 0 when one more call fits (and counts it), else the Retry-After seconds. */
function overLimit(rt: Runtime, key: string, limit: number, now: number): number {
  const w = (rt.windows.get(key) ?? []).filter((t) => now - t < MINUTE);
  if (w.length >= limit) {
    rt.windows.set(key, w);
    rt.calls.overLimit++;
    return Math.max(1, Math.ceil(((w[w.length - limit] as number) + MINUTE - now) / 1000));
  }
  w.push(now);
  rt.windows.set(key, w);
  return 0;
}

const hex16 = (n: number) => Math.max(0, Math.floor(n)).toString(16).padStart(16, '0');

/** A toVersion back to a counter ('0' = everything; anything unreadable = from now). */
function parseVersion(v: unknown): number | null {
  if (typeof v !== 'string' || !/^[0-9a-f]{1,16}$/i.test(v)) return null;
  return Number.parseInt(v, 16);
}

const devicesOf = (ctx: { world: VendorContext['world'] }) =>
  simTelematicsMachines(ctx.world.farm, 'geotab');
const idOf = (m: SimMachine) => m.telematics?.id ?? '';

function sampleAt(ctx: VendorContext, m: SimMachine, wallMs: number): SimMachineSample | null {
  return ctx.world.machineAt(m.id, ctx.simAt(new Date(wallMs)));
}

function onGrid(m: SimMachine, t: number): boolean {
  const every = m.telematics?.reportEverySeconds;
  return !every || t % (every * 1000) === 0;
}

// ---- feeds ------------------------------------------------------------------------------------

/** Grid instants after `from` up to now (at most the catch-up window), as counter indexes. */
function instants(ctx: VendorContext, step: number, from: number, maxInstants: number) {
  const nowMs = ctx.now().getTime();
  const last = Math.floor(nowMs / step);
  const first = Math.max(from + 1, Math.floor((nowMs - ctx.tuning.maxFeedCatchUpMs) / step) + 1);
  const out: number[] = [];
  for (let i = first; i <= last && out.length < maxInstants; i++) out.push(i);
  return { list: out, last };
}

function logRecords(ctx: VendorContext, from: number | null, limit: number): GeotabFeedResult {
  const step = ctx.tuning.gpsIntervalMs;
  const devices = devicesOf(ctx);
  if (from === null) {
    return { data: [], toVersion: hex16(Math.floor(ctx.now().getTime() / step)) };
  }
  const { list } = instants(
    ctx,
    step,
    from,
    Math.max(1, Math.floor(limit / Math.max(1, devices.length))),
  );
  const data: GeotabLogRecord[] = [];
  for (const idx of list) {
    const t = idx * step;
    for (const m of devices) {
      if (!onGrid(m, t)) continue;
      const s = sampleAt(ctx, m, t);
      if (!s) continue;
      data.push({
        id: `b${idx.toString(16)}${idOf(m)}`,
        dateTime: new Date(t).toISOString(),
        device: { id: idOf(m) },
        latitude: round(s.lat, 6),
        longitude: round(s.lng, 6),
        speed: Math.round(Math.max(0, s.speedMph) * KMH_PER_MPH),
      });
    }
  }
  return { data, toVersion: hex16(list.length ? (list[list.length - 1] as number) : from) };
}

/** Every diagnostic the device logs at one instant (the feed ignores any search). */
function statusDataAt(
  m: SimMachine,
  s: SimMachineSample,
  t: number,
  idx: number,
): GeotabStatusData[] {
  const readings: [string, number][] = [
    ['DiagnosticEngineHoursId', Math.round(s.engineHours * 3600)],
    ['DiagnosticOdometerId', Math.round(s.odometerMi * METERS_PER_MILE)],
    ['DiagnosticFuelLevelId', round(s.fuelPct, 1)],
    ['DiagnosticIgnitionId', s.engineOn ? 1 : 0],
    ['DiagnosticEngineSpeedId', s.engineOn ? 1_250 : 0],
    ['DiagnosticEngineCoolantTemperatureId', s.engineOn ? 88 : 18],
  ];
  return readings.map(([diagnostic, data], k) => ({
    id: `a${idx.toString(16)}${k}${idOf(m)}`,
    version: hex16(idx * 8 + k),
    dateTime: new Date(t).toISOString(),
    device: { id: idOf(m) },
    diagnostic: { id: diagnostic },
    data,
  }));
}

function statusData(ctx: VendorContext, from: number | null, limit: number): GeotabFeedResult {
  const step = ctx.tuning.statsIntervalMs;
  const devices = devicesOf(ctx);
  if (from === null) {
    return { data: [], toVersion: hex16(Math.floor(ctx.now().getTime() / step)) };
  }
  const perInstant = Math.max(1, devices.length * 6);
  const { list } = instants(ctx, step, from, Math.max(1, Math.floor(limit / perInstant)));
  const data: GeotabStatusData[] = [];
  for (const idx of list) {
    const t = idx * step;
    for (const m of devices) {
      const s = sampleAt(ctx, m, t);
      if (s) data.push(...statusDataAt(m, s, t, idx));
    }
  }
  return { data, toVersion: hex16(list.length ? (list[list.length - 1] as number) : from) };
}

function faultRecord(f: GeotabSimFault) {
  const p = GEOTAB_SIM_FAULT_PRESETS[f.kind];
  const active = f.state === 'Active';
  return {
    id: f.id,
    dateTime: f.dateTime,
    device: { id: f.deviceId },
    diagnostic: { id: p.diagnostic },
    failureMode: { id: p.failureMode },
    controller: { id: p.controller },
    count: 1,
    faultState: f.state,
    faultLampState: active ? p.faultLampState : 'None',
    redStopLamp: active && p.lamps.redStopLamp,
    amberWarningLamp: active && p.lamps.amberWarningLamp,
    protectWarningLamp: active && p.lamps.protectWarningLamp,
    malfunctionLamp: active && p.lamps.malfunctionLamp,
    severity: p.severity,
    sourceAddress: p.sourceAddress,
    dismissDateTime: null,
  };
}

function faultData(ctx: VendorContext, from: number | null, limit: number): GeotabFeedResult {
  const s = readState(ctx);
  const last = s.nextSeq - 1;
  if (from === null) return { data: [], toVersion: hex16(last) };
  const records = s.faults.filter((f) => f.seq > from).slice(0, limit);
  const to = records.length ? (records[records.length - 1] as GeotabSimFault).seq : from;
  return { data: records.map(faultRecord), toVersion: hex16(to) };
}

function deviceStatusInfo(
  ctx: VendorContext,
  diagnostics: string[] | null,
): GeotabDeviceStatusInfo[] {
  const gps = ctx.tuning.gpsIntervalMs;
  const stats = ctx.tuning.statsIntervalMs;
  const nowMs = ctx.now().getTime();
  return devicesOf(ctx).flatMap((m) => {
    const t = Math.floor(nowMs / gps) * gps;
    const s = sampleAt(ctx, m, t);
    if (!s) return [];
    const info: GeotabDeviceStatusInfo = {
      device: { id: idOf(m) },
      dateTime: new Date(t).toISOString(),
      latitude: round(s.lat, 6),
      longitude: round(s.lng, 6),
      bearing: Math.round(s.heading) % 360,
      speed: Math.round(Math.max(0, s.speedMph) * KMH_PER_MPH),
      isDeviceCommunicating: true,
    };
    if (diagnostics) {
      const idx = Math.floor(nowMs / stats);
      const at = sampleAt(ctx, m, idx * stats);
      info.statusData = at
        ? statusDataAt(m, at, idx * stats, idx).filter((d) => diagnostics.includes(d.diagnostic.id))
        : [];
    }
    return [info];
  });
}

const idsOf = (search: unknown): string[] | null => {
  const ids = (search as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids)) return null;
  return ids.flatMap((x) =>
    typeof x === 'string' ? [x] : typeof x?.id === 'string' ? [x.id as string] : [],
  );
};

function get(ctx: VendorContext, typeName: unknown, search: unknown) {
  switch (typeName) {
    case 'Diagnostic': {
      const ids = idsOf(search);
      return GEOTAB_SIM_DIAGNOSTICS.filter((d) => !ids || ids.includes(d.id));
    }
    case 'FailureMode': {
      const ids = idsOf(search);
      return GEOTAB_SIM_FAILURE_MODES.filter((f) => !ids || ids.includes(f.id));
    }
    case 'Group':
      return GEOTAB_SIM_GROUPS;
    case 'Device':
      return devicesOf(ctx).map((m) => ({
        id: idOf(m),
        name: m.unitNo,
        serialNumber: `G9SIM${idOf(m).toUpperCase()}`.slice(0, 12),
        deviceType: 'GO9',
        vehicleIdentificationNumber: '',
        licensePlate: '',
        groups: [{ id: 'GroupCompanyId' }, ...(m.kind === 'semi' ? [{ id: 'b27C1' }] : [])],
        activeFrom: '2025-01-01T00:00:00.000Z',
        activeTo: '2050-01-01T00:00:00.000Z',
        timeZoneId: 'America/Detroit',
      }));
    case 'DeviceStatusInfo': {
      const d = (search as { diagnostics?: unknown } | null)?.diagnostics;
      return deviceStatusInfo(ctx, Array.isArray(d) ? (idsOf({ ids: d }) ?? []) : null);
    }
    default:
      return null;
  }
}

// ---- JSON-RPC ---------------------------------------------------------------------------------

function sessionOk(ctx: VendorContext, s: GeotabSimState, credentials: unknown): boolean {
  const c = credentials as { database?: unknown; userName?: unknown; sessionId?: unknown } | null;
  const creds = SIM_CREDENTIALS.geotab;
  if (!c || c.database !== creds.database || c.userName !== creds.username) return false;
  if (typeof c.sessionId !== 'string') return false;
  const issued = s.sessions[c.sessionId];
  if (!issued) return false;
  const expired =
    firstOfKind(ctx.faults, 'token_expired') ?? firstOfKind(ctx.faults, 'token_revoked');
  return !expired || Date.parse(issued) >= ctx.ruleStart(expired).getTime();
}

function authenticate(
  ctx: VendorContext,
  rt: Runtime,
  params: Record<string, unknown>,
  id: unknown,
) {
  const creds = SIM_CREDENTIALS.geotab;
  rt.calls.authenticate++;
  if (
    params.userName !== creds.username ||
    params.password !== creds.password ||
    (params.database !== undefined && params.database !== creds.database)
  ) {
    return geotabError('InvalidUserException', 'Incorrect login credentials');
  }
  const now = ctx.now().getTime();
  const wait = overLimit(
    rt,
    `auth|${creds.username}|${creds.database}`,
    AUTHENTICATE_PER_MINUTE,
    now,
  );
  if (wait) {
    return geotabError(
      'OverLimitException',
      'API calls quota exceeded. Maximum admitted 10 per 1m.',
      {
        'retry-after': String(wait),
      },
    );
  }
  const s = readState(ctx);
  const sessionId = ctx.newToken(18);
  const sessions = { ...s.sessions, [sessionId]: new Date(now).toISOString() };
  // The 101st session ends the oldest.
  const ids = Object.keys(sessions).sort(
    (a, b) => Date.parse(sessions[a] ?? '') - Date.parse(sessions[b] ?? ''),
  );
  while (ids.length > MAX_SESSIONS_PER_USER) delete sessions[ids.shift() as string];
  writeState(ctx, { ...s, sessions });
  const result: GeotabLoginResult = {
    credentials: { database: creds.database, userName: creds.username, sessionId },
    ...(s.loginPath === null ? {} : { path: s.loginPath }),
  };
  return rpcResult(result, id);
}

function rpc(req: SimRequest, ctx: VendorContext): SimResponse {
  let body: { method?: unknown; params?: unknown; id?: unknown };
  try {
    body = JSON.parse(req.body || 'null') ?? {};
  } catch {
    return geotabError('JsonSerializerException', 'The request is not valid JSON');
  }
  const rt = runtime(ctx);
  const host = header(req.headers, 'host') ?? '';
  rt.calls.hosts[host] = (rt.calls.hosts[host] ?? 0) + 1;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = (body.params && typeof body.params === 'object' ? body.params : {}) as Record<
    string,
    unknown
  >;
  if (method === 'GetVersion') return rpcResult(GEOTAB_SIM_VERSION, body.id);
  if (method === 'Authenticate') return authenticate(ctx, rt, params, body.id);
  if (method !== 'GetFeed' && method !== 'Get') {
    return geotabError(
      'MissingMethodException',
      `The method '${method}' could not be found (not simulated)`,
    );
  }
  const s = readState(ctx);
  if (!sessionOk(ctx, s, params.credentials)) {
    return geotabError(
      'InvalidUserException',
      `Invalid session @ '${SIM_CREDENTIALS.geotab.database}'`,
    );
  }
  const typeName = params.typeName;
  if (method === 'Get') {
    rt.calls.get[String(typeName)] = (rt.calls.get[String(typeName)] ?? 0) + 1;
    const result = get(ctx, typeName, params.search);
    if (result === null)
      return geotabError('ArgumentException', `Get ${String(typeName)} is not simulated`);
    return rpcResult(result, body.id);
  }
  const t = String(typeName);
  rt.calls.getFeed[t] = (rt.calls.getFeed[t] ?? 0) + 1;
  const wait = overLimit(
    rt,
    `feed|${t}|${SIM_CREDENTIALS.geotab.username}|${SIM_CREDENTIALS.geotab.database}`,
    GETFEED_PER_MINUTE,
    ctx.now().getTime(),
  );
  if (wait) {
    return geotabError(
      'OverLimitException',
      'API calls quota exceeded. Maximum admitted 60 per 1m.',
      {
        'retry-after': String(wait),
      },
    );
  }
  if (s.limitedScope && (t === 'LogRecord' || t === 'StatusData')) {
    return geotabError(
      'ArgumentException',
      `GetFeed for ${t} is not supported for users with limited data access (whole-fleet scope required)`,
    );
  }
  const from =
    params.fromVersion === undefined || params.fromVersion === null
      ? null
      : (parseVersion(params.fromVersion) ?? null);
  const limit = Math.min(
    MAX_RESULTS,
    Math.max(1, Number(params.resultsLimit ?? MAX_RESULTS) || MAX_RESULTS),
  );
  switch (t) {
    case 'LogRecord':
      return rpcResult(logRecords(ctx, from, limit), body.id);
    case 'StatusData':
      return rpcResult(statusData(ctx, from, limit), body.id);
    case 'FaultData':
      return rpcResult(faultData(ctx, from, limit), body.id);
    default:
      return geotabError('ArgumentException', `GetFeed ${t} is not simulated`);
  }
}

// ---- control ----------------------------------------------------------------------------------

function status(ctx: VendorControlContext): GeotabSimStatus {
  const s = readState(ctx);
  return {
    devices: devicesOf(ctx).map((m) => ({ id: idOf(m), unitNo: m.unitNo })),
    loginPath: s.loginPath,
    limitedScope: s.limitedScope,
    sessions: Object.keys(s.sessions).length,
    calls: structuredClone(runtime(ctx).calls),
    faults: s.faults,
  };
}

const issue = (e: { issues: { path: PropertyKey[]; message: string }[] }) => {
  const i = e.issues[0];
  return i ? `${i.path.join('.') || '(body)'}: ${i.message}` : 'bad request';
};

function control(req: SimRequest, ctx: VendorControlContext): SimResponse {
  const path = req.path.replace(/\/+$/, '') || '/';
  if (!['/status', '/faults', '/server'].includes(path)) {
    return json(404, { error: `unknown Geotab control path ${path}` });
  }
  if (req.method === 'GET') return json(200, status(ctx));
  if (req.method !== 'POST' || path === '/status') {
    return json(405, { error: `${req.method} not allowed on ${path}` });
  }
  let value: unknown;
  try {
    value = req.body ? JSON.parse(req.body) : {};
  } catch {
    return json(400, { error: 'body must be JSON' });
  }
  const s = readState(ctx);
  const now = new Date(Math.floor(ctx.now().getTime() / 1000) * 1000).toISOString();
  if (path === '/server') {
    const r = geotabSimServerRequestSchema.safeParse(value);
    if (!r.success) return json(400, { error: issue(r.error) });
    writeState(ctx, {
      ...s,
      ...(r.data.loginPath === undefined ? {} : { loginPath: r.data.loginPath }),
      ...(r.data.limitedScope === undefined ? {} : { limitedScope: r.data.limitedScope }),
      ...(r.data.expireSessions ? { sessions: {} } : {}),
    });
    ctx.log(`geotab server: ${JSON.stringify(r.data)}`);
    return json(200, status(ctx));
  }
  const r = geotabSimFaultRequestSchema.safeParse(value);
  if (!r.success) return json(400, { error: issue(r.error) });
  const a = r.data;
  if (a.action === 'reset') {
    writeState(ctx, { ...s, faults: [] });
  } else if (a.action === 'raise') {
    const deviceId = a.deviceId ?? (devicesOf(ctx)[0] ? idOf(devicesOf(ctx)[0] as SimMachine) : '');
    if (!deviceId) return json(409, { error: 'no Geotab device in this world' });
    const id = `aF${s.nextSeq.toString(16).toUpperCase()}`;
    const f: GeotabSimFault = {
      id,
      faultId: id,
      seq: s.nextSeq,
      deviceId,
      kind: a.kind ?? 'j1939',
      state: 'Active',
      dateTime: now,
    };
    writeState(ctx, { ...s, faults: [...s.faults, f], nextSeq: s.nextSeq + 1 });
    ctx.log(`geotab fault ${id} raised (${f.kind}) on ${deviceId}`);
  } else {
    const raised = s.faults.find((f) => f.id === a.id && f.state === 'Active');
    if (!raised) return json(404, { error: `no active Geotab fault ${a.id}` });
    const f: GeotabSimFault = {
      ...raised,
      id: `aF${s.nextSeq.toString(16).toUpperCase()}`,
      seq: s.nextSeq,
      state: 'Inactive',
      dateTime: now,
    };
    writeState(ctx, { ...s, faults: [...s.faults, f], nextSeq: s.nextSeq + 1 });
    ctx.log(`geotab fault ${raised.id} cleared`);
  }
  return json(200, status(ctx));
}

export const geotabModule: VendorModule = {
  vendor: 'geotab',
  // Fault injection (http_error, rate_limit) keeps the HTTP status it asks for.
  error: (status, message, headers) =>
    geotabError(
      status === 429 ? 'OverLimitException' : 'GenericException',
      message,
      headers,
      status,
    ),
  handle(req, ctx) {
    const path = req.path.replace(/\/+$/, '');
    if (path !== '/apiv1') {
      return geotabError('MissingMethodException', `Not found: ${req.path} (not simulated)`);
    }
    if (req.method !== 'POST') {
      return geotabError('MissingMethodException', 'Use POST with a JSON-RPC body (not simulated)');
    }
    return rpc(req, ctx);
  },
  control,
};
