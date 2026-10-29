/**
 * NWS stand-in (mounted at /nws; docs/contracts-m1.md §11): api.weather.gov-shaped answers
 * computed from the simulated weather (./weather.ts, ./forecast.ts), so the live NWS client
 * (src/connectors/nws) runs unchanged in sim mode against `${VENDOR_SIM_URL}/nws`.
 *
 *   GET /points/{lat},{lon}                              grid cell + links (Feature)
 *   GET /gridpoints/{wfo}/{x},{y}                        raw forecast layers (Feature)
 *   GET /gridpoints/{wfo}/{x},{y}/stations               stations, nearest first
 *   GET /stations/{id}/observations[?start&end&limit]    newest first (FeatureCollection)
 *   GET /stations/{id}/observations/latest               (Feature)
 *
 * Like api.weather.gov: GeoJSON bodies (`application/geo+json`), errors as
 * `application/problem+json` (ProblemDetail), and a request without a User-Agent is refused
 * (403; NWS: "All applications must provide a unique User-Agent string"). Paths and shapes from
 * the NWS OpenAPI document (https://api.weather.gov/openapi.json).
 *
 * Control (served at /_control/vendor/nws/…, loopback only): GET/POST /weather, the wind slider
 * and the weather pattern (./control-types.ts).
 */
import { randomUUID } from 'node:crypto';
import type { ScenarioName } from '../../types';
import type { VendorContext, VendorControlContext, VendorModule } from '../context';
import { header, json, type SimRequest, type SimResponse } from '../http';
import {
  EMPTY_NWS_SIM_WEATHER,
  type NwsSimWeatherState,
  type NwsSimWeatherStatus,
  type NwsWeatherPattern,
  nwsSimWeatherRequestSchema,
  nwsSimWeatherStateSchema,
} from './control-types';
import {
  buildGridpoint,
  buildObservation,
  buildPoint,
  buildStations,
  currentIssue,
  nwsInstant,
  observationInstants,
} from './forecast';
import { isSimCell, SIM_STATIONS, simCellAt, simStation } from './grid';
import { SCENARIO_WEATHER, simWeatherAt } from './weather';

const GEOJSON = { 'content-type': 'application/geo+json' };
/** Observations served at most per request (NWS: limit 1-500). */
const MAX_OBSERVATIONS = 500;
/** Default and furthest look-back of /observations (NWS keeps about a week; we serve a day). */
const OBSERVATION_LOOKBACK_MS = 24 * 3_600_000;

const PROBLEM_TITLES: Record<number, [string, string]> = {
  400: ['BadRequest', 'Bad Request'],
  403: ['Forbidden', 'Forbidden'],
  404: ['NotFound', 'Not Found'],
  405: ['MethodNotAllowed', 'Method Not Allowed'],
  429: ['RateLimit', 'Rate Limit Exceeded'],
};

function nwsError(status: number, message: string, headers: Record<string, string> = {}) {
  const id = randomUUID();
  const [type, title] = PROBLEM_TITLES[status] ?? ['UnexpectedProblem', 'Unexpected Problem'];
  return json(
    status,
    {
      type: `urn:noaa:nws:api:${type}`,
      title,
      status,
      detail: message,
      instance: `urn:noaa:nws:api:request:${id}`,
      correlationId: id,
    },
    { 'content-type': 'application/problem+json', ...headers },
  );
}

/** The persisted knobs (lenient: a bad or missing bag is the default). */
export function readNwsSimState(state: {
  vendors?: Record<string, Record<string, unknown>>;
}): NwsSimWeatherState {
  const r = nwsSimWeatherStateSchema.safeParse(state.vendors?.nws);
  return r.success ? r.data : { ...EMPTY_NWS_SIM_WEATHER };
}

function effectivePattern(
  world: { scenario: ScenarioName },
  s: NwsSimWeatherState,
): NwsWeatherPattern {
  return s.pattern ?? SCENARIO_WEATHER[world.scenario];
}

/** Absolute URL of the stand-in's /nws root as the client addressed it. */
function baseOf(req: SimRequest): string {
  return `${req.url.origin}/nws`;
}

const POINT_RE = /^\/points\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;
const GRID_RE = /^\/gridpoints\/([A-Z]{3})\/(\d+),(\d+)(\/stations)?$/;
const OBS_RE = /^\/stations\/([A-Z0-9]{3,8})\/observations(\/latest)?$/;

function points(req: SimRequest, m: RegExpExecArray): SimResponse {
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return nwsError(400, `Invalid parameter "point": ${m[1]},${m[2]}`);
  }
  const body = buildPoint(baseOf(req), lat, lng);
  if (!body) return nwsError(404, `Unable to provide data for requested point ${lat},${lng}`);
  return json(200, body, GEOJSON);
}

function gridpoint(req: SimRequest, ctx: VendorContext, m: RegExpExecArray): SimResponse {
  const wfo = m[1] as string;
  const x = Number(m[2]);
  const y = Number(m[3]);
  if (!isSimCell(wfo, x, y)) return nwsError(404, `Grid point ${wfo}/${x},${y} does not exist`);
  const base = baseOf(req);
  if (m[4]) {
    const limit = Number(req.url.searchParams.get('limit') ?? '') || SIM_STATIONS.length;
    return json(200, buildStations(base, x, y, SIM_STATIONS, Math.max(1, limit)), GEOJSON);
  }
  const s = readNwsSimState(ctx.state);
  const issue = currentIssue(ctx.state.clock, ctx.now(), s.changedAt);
  return json(
    200,
    buildGridpoint({
      base,
      wfo,
      x,
      y,
      issue,
      pattern: effectivePattern(ctx.world, s),
      windMph: s.windMph,
    }),
    GEOJSON,
  );
}

function observations(req: SimRequest, ctx: VendorContext, m: RegExpExecArray): SimResponse {
  const station = simStation(m[1] as string);
  if (!station) return nwsError(404, `Station ${m[1]} not found`);
  const s = readNwsSimState(ctx.state);
  const base = baseOf(req);
  const pattern = effectivePattern(ctx.world, s);
  const nowMs = ctx.now().getTime();
  const feature = (wallMs: number) =>
    buildObservation({
      base,
      station,
      wallMs,
      simMs: ctx.simAt(new Date(wallMs)).getTime(),
      pattern,
      windMph: s.windMph,
    });
  if (m[2]) {
    const [latest] = observationInstants(nowMs - OBSERVATION_LOOKBACK_MS, nowMs, 1);
    return latest === undefined
      ? nwsError(404, `No observations for ${station.id}`)
      : json(200, feature(latest), GEOJSON);
  }
  const q = req.url.searchParams;
  const parse = (k: string): number | null => {
    const v = q.get(k);
    return v === null ? null : Date.parse(v);
  };
  const start = parse('start');
  const end = parse('end');
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return nwsError(400, 'Invalid parameter "start" or "end": not a date-time');
  }
  const limitRaw = q.get('limit');
  const limit = limitRaw === null ? MAX_OBSERVATIONS : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OBSERVATIONS) {
    return nwsError(400, `Invalid parameter "limit": must be 1-${MAX_OBSERVATIONS}`);
  }
  const to = Math.min(end ?? nowMs, nowMs);
  // NWS's start is inclusive: on the 20-minute grid, (start - 1 ms, to] is the same set.
  const oldest = nowMs - OBSERVATION_LOOKBACK_MS;
  const from = Math.max(start === null ? oldest : start - 1, oldest);
  return json(
    200,
    {
      '@context': ['https://geojson.org/geojson-ld/geojson-context.jsonld'],
      type: 'FeatureCollection',
      features: observationInstants(from, to, limit).map(feature),
    },
    GEOJSON,
  );
}

// ---------------------------------------------------------------------------------------------
// Control: the wind slider and the pattern
// ---------------------------------------------------------------------------------------------

/** GET/POST /weather status. */
export function nwsSimStatus(ctx: VendorControlContext): NwsSimWeatherStatus {
  const s = readNwsSimState(ctx.state);
  const pattern = effectivePattern(ctx.world, s);
  const wallNow = ctx.now();
  const simNow = ctx.simAt(wallNow);
  const issue = currentIssue(ctx.state.clock, wallNow, s.changedAt);
  const station = SIM_STATIONS[0] as (typeof SIM_STATIONS)[number];
  const cell = simCellAt(station.lng, station.lat) ?? { x: 0, y: 0 };
  const w = simWeatherAt(simNow.getTime(), { pattern, cell, windMph: s.windMph });
  const one = (v: number) => Math.round(v * 10) / 10;
  return {
    ...s,
    scenario: ctx.world.scenario,
    defaultPattern: SCENARIO_WEATHER[ctx.world.scenario],
    effectivePattern: pattern,
    issuedAt: nwsInstant(issue.updateMs),
    simNow: simNow.toISOString(),
    sample: {
      stationId: station.id,
      tempF: one(w.tempF),
      windMph: one(w.windMph),
      gustMph: one(w.gustMph),
      windDir: Math.round(w.windDir),
      popPct: Math.round(w.popPct),
      skyPct: Math.round(w.skyPct),
    },
  };
}

function control(req: SimRequest, ctx: VendorControlContext): SimResponse {
  const path = req.path.replace(/\/+$/, '') || '/';
  if (path !== '/weather') return json(404, { error: `unknown NWS control path ${path}` });
  if (req.method === 'GET') return json(200, nwsSimStatus(ctx));
  if (req.method !== 'POST') return json(405, { error: `${req.method} not allowed on /weather` });
  let value: unknown;
  try {
    value = req.body ? JSON.parse(req.body) : {};
  } catch {
    return json(400, { error: 'body must be JSON' });
  }
  const parsed = nwsSimWeatherRequestSchema.safeParse(value);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return json(400, {
      error: i ? `${i.path.join('.') || '(body)'}: ${i.message}` : 'bad request',
    });
  }
  const cur = readNwsSimState(ctx.state);
  const { pattern, windMph } = parsed.data;
  const next: NwsSimWeatherState = {
    pattern: pattern === undefined ? cur.pattern : pattern,
    windMph:
      windMph === undefined ? cur.windMph : windMph === null ? null : Math.round(windMph * 10) / 10,
    changedAt: new Date(Math.floor(ctx.now().getTime() / 1000) * 1000).toISOString(),
  };
  ctx.state.vendors = { ...(ctx.state.vendors ?? {}), nws: { ...next } };
  ctx.persist();
  ctx.log(
    `nws weather: pattern ${next.pattern ?? '(scenario)'}, wind ${next.windMph === null ? '(pattern)' : `${next.windMph} mph`}`,
  );
  return json(200, nwsSimStatus(ctx));
}

export const nwsModule: VendorModule = {
  vendor: 'nws',
  error: nwsError,
  handle(req, ctx) {
    if (req.method !== 'GET') return nwsError(405, `${req.method} is not supported`);
    if (!header(req.headers, 'user-agent')?.trim()) {
      return nwsError(403, 'A User-Agent header is required to identify your application');
    }
    let m = POINT_RE.exec(req.path);
    if (m) return points(req, m);
    m = GRID_RE.exec(req.path);
    if (m) return gridpoint(req, ctx, m);
    m = OBS_RE.exec(req.path);
    if (m) return observations(req, ctx, m);
    return nwsError(404, `${req.path} not found`);
  },
  control,
};
