/**
 * The vendor stand-in server (plan §5 "Vendor API stand-ins", contracts §9): one node:http
 * server on loopback that answers like each vendor under a path prefix, computed from the
 * simulated world, plus the control API under /_control (403 unless the caller is loopback).
 *
 *   /samsara/...  ./samsara/routes.ts      /deere/...   ./deere/routes.ts
 *   /motive/...   ./motive/routes.ts       /nws/...     ./nws/routes.ts (1b)
 *   /qbo          404 until its slice (M3)
 *   /_control/status | clock | scenario | faults | reset | stats
 *
 * `startVendorSim()` is used by the CLI (tools/vendor-sim/index.ts, state in
 * .data/vendor-sim/state.json) and in-process by the contract tests (random port, a stub world,
 * memory state). The world comes from an injected `createWorld` (the sim agent's
 * `createSimWorld` in production).
 *
 * Generic faults are applied here before the vendor route runs: outage (drop the socket),
 * timeout (hold, then drop), latency, http_error and rate_limit (vendor-shaped bodies via the
 * module's `error()`). Token and page faults are applied by the vendor routes.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { z } from 'zod';
import {
  type ClockControlRequest,
  type CreateSimWorld,
  type FaultRule,
  type FaultsControlRequest,
  type FaultsStatus,
  type ResetControlRequest,
  type ScenarioControlRequest,
  type ScenarioName,
  type ScenarioStatus,
  SIM_VENDORS,
  type SimStatus,
  type SimVendor,
  type SimWorld,
} from '../types';
import {
  applyClockRequest,
  ClockRequestError,
  clockStatus,
  currentClock,
  simAt,
  startTimeline,
} from './clock';
import {
  DEFAULT_TUNING,
  type VendorContext,
  type VendorControlContext,
  type VendorModule,
  type VendorSimCounters,
  type VendorSimTuning,
} from './context';
import {
  clockControlRequestSchema,
  firstIssue,
  resetControlRequestSchema,
  scenarioControlRequestSchema,
} from './control';
import { deereModule } from './deere/routes';
import {
  applyFaultsRequest,
  FaultRequestError,
  faultsControlRequestSchema,
  firstOfKind,
  matchFaults,
  scenarioFaultRules,
} from './faults';
import { json, type SimRequest, type SimResponse } from './http';
import { motiveModule } from './motive/routes';
import { nwsModule } from './nws/routes';
import { samsaraModule } from './samsara/routes';
import {
  emptyDeereOAuth,
  memoryStateStore,
  parseVendorSimState,
  pruneGrants,
  type StateStore,
  VENDOR_SIM_STATE_VERSION,
  type VendorSimState,
} from './state';

export const DEFAULT_VENDOR_SIM_PORT = 4010;
const MAX_BODY_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_HOLD_MS = 60_000;

const MODULES: Partial<Record<SimVendor, VendorModule>> = {
  samsara: samsaraModule,
  deere: deereModule,
  motive: motiveModule,
  nws: nwsModule,
};

export interface VendorSimOptions {
  /** World factory: `createSimWorld` from src/sim/index.ts, or a stub in tests. */
  createWorld: CreateSimWorld;
  /** Default 127.0.0.1 (loopback only). */
  host?: string;
  /** Default 4010; 0 = a random free port. */
  port?: number;
  /** Persisted state (default: in memory). */
  store?: StateStore;
  /** Boot scenario / seed (a persisted state for the same scenario and seed is resumed). */
  scenario?: ScenarioName;
  seed?: number;
  /** Boot speed (applied when it differs from the persisted clock). */
  speed?: number;
  /** SIM_FROZEN_AT: freeze sim time here at boot. */
  frozenAt?: Date | null;
  /** Ignore the persisted state. */
  fresh?: boolean;
  /** Wall clock (tests). */
  now?: () => Date;
  tuning?: Partial<VendorSimTuning>;
  /** Notable events (control changes, faults). Default: none. */
  log?: (line: string) => void;
  /** Also log every vendor request. */
  logRequests?: boolean;
  /** Replace or add vendor modules (tests). */
  modules?: Partial<Record<SimVendor, VendorModule>>;
}

export interface VendorSim {
  /** e.g. http://127.0.0.1:4010 (no trailing slash). */
  readonly url: string;
  readonly port: number;
  readonly world: SimWorld;
  readonly counters: VendorSimCounters;
  status(): SimStatus;
  /** Same as POST /_control/<x>, in-process (tests). */
  control: {
    clock(req: ClockControlRequest): SimStatus['clock'];
    scenario(req: ScenarioControlRequest): ScenarioStatus;
    faults(req: FaultsControlRequest): FaultsStatus;
    reset(req?: ResetControlRequest): SimStatus;
  };
  close(): Promise<void>;
}

export class VendorSimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VendorSimError';
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_LISTEN_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLoopbackAddress(addr: string | undefined): boolean {
  return !!addr && (LOOPBACK.has(addr) || addr.startsWith('127.'));
}

/**
 * Why a /_control request is refused, or null. The loopback socket check alone lets any web page
 * open in the PC's browser drive the control API: a cross-site `fetch(…, { mode: 'no-cors' })`
 * with a text/plain body needs no preflight, and DNS rebinding reads the answers. So also:
 * the Host header must name a loopback host (defeats rebinding), an Origin header must be the
 * stand-in's own (no cross-site requests), and a POST must be application/json (which a
 * cross-site page can only send after a CORS preflight the stand-in never approves). The admin
 * page's server actions, tools/dev.ts and the tests call from Node with JSON and no Origin.
 */
export function controlRefusal(req: {
  remoteAddress: string | undefined;
  method: string;
  host: string | undefined;
  origin: string | undefined;
  contentType: string | undefined;
}): { status: number; error: string } | null {
  if (!isLoopbackAddress(req.remoteAddress)) {
    return { status: 403, error: 'control API is loopback-only' };
  }
  let hostname = '';
  try {
    hostname = new URL(`http://${req.host ?? ''}`).hostname;
  } catch {
    // stays '' (refused below)
  }
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    return { status: 403, error: 'control API: the Host header must be a loopback host' };
  }
  if (req.origin !== undefined) {
    let host = '';
    try {
      host = new URL(req.origin).host;
    } catch {
      // stays '' (refused below)
    }
    if (host !== req.host) return { status: 403, error: 'control API: cross-origin request' };
  }
  if (req.method === 'POST' && !/^application\/json\b/i.test(req.contentType ?? '')) {
    return { status: 415, error: 'control API: POST bodies must be application/json' };
  }
  return null;
}

function newCounters(): VendorSimCounters {
  return {
    requests: {},
    tokenGrants: { authorization_code: 0, refresh_token: 0 },
    faults: {},
  };
}

export async function startVendorSim(opts: VendorSimOptions): Promise<VendorSim> {
  const now = opts.now ?? (() => new Date());
  const tuning: VendorSimTuning = { ...DEFAULT_TUNING, ...opts.tuning };
  const store = opts.store ?? memoryStateStore();
  const log = opts.log ?? (() => {});
  const host = opts.host ?? '127.0.0.1';
  if (!LOOPBACK_LISTEN_HOSTS.has(host)) {
    throw new VendorSimError(`the stand-in is loopback-only: refusing to listen on '${host}'`);
  }

  const makeWorld = (scenario: ScenarioName, seed: number): SimWorld => {
    try {
      return opts.createWorld({ scenario, seed });
    } catch (e) {
      throw new VendorSimError(
        `createSimWorld({ scenario: '${scenario}', seed: ${seed} }) failed: ${(e as Error).message}`,
      );
    }
  };

  // ---- boot ------------------------------------------------------------------------------
  const loaded = opts.fresh ? null : parseVendorSimState(store.load());
  const bootScenario = opts.scenario ?? loaded?.scenario ?? 'harvest-day';
  const bootSeed = opts.seed ?? loaded?.seed ?? 1;
  let world = makeWorld(bootScenario, bootSeed);
  let state: VendorSimState;
  if (loaded && loaded.scenario === bootScenario && loaded.seed === bootSeed) {
    state = loaded;
    log(`resumed ${bootScenario} (seed ${bootSeed}) from saved state`);
  } else {
    state = freshState(world, now(), opts.speed ?? 1);
    log(`started ${bootScenario} (seed ${bootSeed}) at sim ${world.startsAt.toISOString()}`);
  }
  if (opts.speed !== undefined && currentClock(state.clock).speed !== opts.speed) {
    state.clock = applyClockRequest(state.clock, { action: 'speed', speed: opts.speed }, now());
  }
  if (opts.frozenAt) {
    state.clock = applyClockRequest(
      state.clock,
      { action: 'freeze', simTime: opts.frozenAt.toISOString() },
      now(),
    );
    log(`frozen at sim ${opts.frozenAt.toISOString()} (SIM_FROZEN_AT)`);
  }
  let scenarioRules = scenarioFaultRules(world.scenario, world.startsAt);
  // The first America/Detroit lookup costs about 0.5 s on Windows (measured on a CI runner) and
  // much more on a busy PC, which pushed the launcher's first /_control/scenario call past its
  // timeout. Pay it at boot instead.
  scenarioFaultRules('bad-morning', world.startsAt);

  const modules: Partial<Record<SimVendor, VendorModule>> = { ...MODULES, ...opts.modules };

  const persist = () => {
    state.deere = pruneGrants(state.deere, now());
    store.save(state);
  };
  persist();

  const counters = newCounters();
  const seqs = new Map<string, number>();
  const lastPages = new Map<string, { after: string | null; body: unknown }>();
  /** Wall time each rule was first seen active (token cut-offs). */
  const firstActive = new Map<string, number>();
  const timers = new Set<NodeJS.Timeout>();

  function freshState(w: SimWorld, wallNow: Date, speed: number): VendorSimState {
    return {
      version: VENDOR_SIM_STATE_VERSION,
      scenario: w.scenario,
      seed: w.seed,
      clock: startTimeline(w.startsAt, wallNow, { speed }),
      faults: [],
      deere: emptyDeereOAuth(),
    };
  }

  // ---- control ---------------------------------------------------------------------------
  const scenarioStatus = (): ScenarioStatus => ({
    scenario: world.scenario,
    seed: world.seed,
    startsAt: world.startsAt.toISOString(),
  });
  const faultsStatus = (): FaultsStatus => ({ rules: state.faults, scenarioRules });
  const status = (): SimStatus => ({
    clock: clockStatus(state.clock, now()),
    scenario: scenarioStatus(),
    faults: faultsStatus(),
  });

  const control: VendorSim['control'] = {
    clock(req) {
      state.clock = applyClockRequest(state.clock, req, now());
      persist();
      log(
        `clock ${req.action}${'speed' in req ? ` ${req.speed}` : ''}${'simTime' in req ? ` ${req.simTime}` : ''}`,
      );
      return clockStatus(state.clock, now());
    },
    scenario(req) {
      const seed = req.seed ?? state.seed;
      world = makeWorld(req.scenario, seed);
      scenarioRules = scenarioFaultRules(world.scenario, world.startsAt);
      state.scenario = world.scenario;
      state.seed = world.seed;
      state.clock = startTimeline(world.startsAt, now(), {
        speed: currentClock(state.clock).speed,
      });
      lastPages.clear();
      persist();
      log(`scenario ${world.scenario} (seed ${world.seed})`);
      return scenarioStatus();
    },
    faults(req) {
      const before = new Set(state.faults.map((r) => r.id));
      state.faults = applyFaultsRequest(
        state.faults,
        req,
        () => `rule-${randomUUID().slice(0, 8)}`,
      );
      const t = now().getTime();
      for (const r of state.faults) if (!before.has(r.id)) firstActive.set(r.id, t);
      for (const id of before) {
        if (!state.faults.some((r) => r.id === id)) firstActive.delete(id);
      }
      persist();
      log(
        `faults ${req.action}: ${state.faults.map((r) => r.label ?? `${r.vendor}/${r.kind}`).join(', ') || 'none'}`,
      );
      return faultsStatus();
    },
    reset(req = {}) {
      const scenario = req.scenario ?? state.scenario;
      const seed = req.seed ?? state.seed;
      world = makeWorld(scenario, seed);
      scenarioRules = scenarioFaultRules(world.scenario, world.startsAt);
      const faults = req.clearFaults === false ? state.faults : [];
      state = freshState(world, now(), req.speed ?? 1);
      state.faults = faults;
      lastPages.clear();
      firstActive.clear();
      persist();
      log(`reset: ${scenario} (seed ${seed})`);
      return status();
    },
  };

  function parsed<T>(schema: z.ZodType<T>, body: string): T | SimResponse {
    let value: unknown;
    try {
      value = body ? JSON.parse(body) : {};
    } catch {
      return json(400, { error: 'body must be JSON' });
    }
    const r = schema.safeParse(value);
    return r.success ? r.data : json(400, { error: firstIssue(r.error) });
  }

  function controlRoute(method: string, path: string, body: string): SimResponse {
    const get = method === 'GET';
    const post = method === 'POST';
    try {
      switch (path) {
        case '/status':
          return get ? json(200, status()) : json(405, { error: 'GET only' });
        case '/stats':
          return get ? json(200, counters) : json(405, { error: 'GET only' });
        case '/clock': {
          if (get) return json(200, clockStatus(state.clock, now()));
          if (!post) break;
          const req = parsed(clockControlRequestSchema, body);
          return 'kind' in req ? req : json(200, control.clock(req));
        }
        case '/scenario': {
          if (get) return json(200, scenarioStatus());
          if (!post) break;
          const req = parsed(scenarioControlRequestSchema, body);
          return 'kind' in req ? req : json(200, control.scenario(req));
        }
        case '/faults': {
          if (get) return json(200, faultsStatus());
          if (!post) break;
          const req = parsed(faultsControlRequestSchema, body);
          return 'kind' in req ? req : json(200, control.faults(req as FaultsControlRequest));
        }
        case '/reset': {
          if (!post) break;
          const req = parsed(resetControlRequestSchema, body);
          return 'kind' in req ? req : json(200, control.reset(req));
        }
        default:
          return json(404, { error: `unknown control path ${path}` });
      }
      return json(405, { error: `${method} not allowed on /_control${path}` });
    } catch (e) {
      if (e instanceof ClockRequestError || e instanceof FaultRequestError) {
        return json(400, { error: e.message });
      }
      if (e instanceof VendorSimError) return json(500, { error: e.message });
      throw e;
    }
  }

  // ---- per-vendor control (M1) ------------------------------------------------------------
  async function moduleControl(
    vendor: string,
    path: string,
    method: string,
    url: URL,
    headers: http.IncomingHttpHeaders,
    body: string,
  ): Promise<SimResponse> {
    const mod = (SIM_VENDORS as readonly string[]).includes(vendor)
      ? modules[vendor as SimVendor]
      : undefined;
    if (!mod?.control) return json(404, { error: `no control API for '${vendor}'` });
    const ctx: VendorControlContext = {
      vendor: mod.vendor,
      world,
      now,
      simAt: (wall) => simAt(state.clock, wall),
      state,
      persist,
      log,
    };
    return mod.control({ method, url, path, headers, body, seq: 0 }, ctx);
  }

  // ---- vendors ---------------------------------------------------------------------------
  async function vendorRoute(
    mod: VendorModule,
    method: string,
    url: URL,
    path: string,
    headers: http.IncomingHttpHeaders,
    body: string,
  ): Promise<SimResponse> {
    const vendor = mod.vendor;
    const seq = (seqs.get(vendor) ?? 0) + 1;
    seqs.set(vendor, seq);
    counters.requests[vendor] = (counters.requests[vendor] ?? 0) + 1;
    const wallNow = now();
    const simNow = simAt(state.clock, wallNow);
    const rules: FaultRule[] = [...state.faults, ...scenarioRules];
    const faults = matchFaults(rules, { vendor, path, wallNow, simNow, seq });
    for (const r of faults) if (!firstActive.has(r.id)) firstActive.set(r.id, wallNow.getTime());
    const hit = (kind: string) => {
      counters.faults[kind] = (counters.faults[kind] ?? 0) + 1;
    };

    if (firstOfKind(faults, 'outage')) {
      hit('outage');
      return { kind: 'drop' };
    }
    const timeout = firstOfKind(faults, 'timeout');
    if (timeout) {
      hit('timeout');
      return { kind: 'drop', afterMs: timeout.latencyMs ?? DEFAULT_TIMEOUT_HOLD_MS };
    }
    const latency = firstOfKind(faults, 'latency');
    if (latency?.latencyMs) {
      hit('latency');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          timers.delete(t);
          resolve();
        }, latency.latencyMs);
        timers.add(t);
      });
    }
    const httpError = firstOfKind(faults, 'http_error');
    if (httpError) {
      hit('http_error');
      return mod.error(httpError.status ?? 500, 'Simulated server error');
    }
    const rateLimit = firstOfKind(faults, 'rate_limit');
    if (rateLimit) {
      hit('rate_limit');
      return mod.error(429, 'Rate limit exceeded', {
        'retry-after': String(rateLimit.retryAfterSeconds ?? 30),
      });
    }

    const ctx: VendorContext = {
      vendor,
      world,
      tuning,
      now,
      simAt: (wall) => simAt(state.clock, wall),
      faults,
      ruleStart: (rule) =>
        new Date(
          rule.from ? Date.parse(rule.from) : (firstActive.get(rule.id) ?? wallNow.getTime()),
        ),
      state,
      persist,
      lastPages,
      counters,
      newToken: (bytes = 24) => randomBytes(bytes).toString('base64url'),
      log,
    };
    const simReq: SimRequest = { method, url, path, headers, body, seq };
    return mod.handle(simReq, ctx);
  }

  // ---- socket handling -------------------------------------------------------------------
  function send(req: http.IncomingMessage, res: http.ServerResponse, r: SimResponse): void {
    if (r.kind === 'drop') {
      if (!r.afterMs) {
        req.socket.destroy();
        return;
      }
      const t = setTimeout(() => {
        timers.delete(t);
        req.socket.destroy();
      }, r.afterMs);
      timers.add(t);
      return;
    }
    res.writeHead(r.status, { 'cache-control': 'no-store', ...r.headers });
    res.end(r.body ?? '');
  }

  function readBody(req: http.IncomingMessage): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          resolve(null);
          req.resume();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString()));
      req.on('error', reject);
    });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);
    const body = await readBody(req);
    if (body === null) return send(req, res, json(413, { error: 'body too large' }));
    const segs = url.pathname.split('/');
    const root = segs[1] ?? '';
    const rest = `/${segs.slice(2).join('/')}`;
    if (root === '_control') {
      const refused = controlRefusal({
        remoteAddress: req.socket.remoteAddress,
        method,
        host: req.headers.host,
        origin: req.headers.origin,
        contentType: req.headers['content-type'],
      });
      if (refused) return send(req, res, json(refused.status, { error: refused.error }));
      const vendorControl = /^\/vendor\/([a-z]+)(\/.*)?$/.exec(rest);
      if (vendorControl) {
        return send(
          req,
          res,
          await moduleControl(
            vendorControl[1] ?? '',
            vendorControl[2] ?? '/',
            method,
            url,
            req.headers,
            body,
          ),
        );
      }
      return send(req, res, controlRoute(method, rest.replace(/\/$/, '') || '/', body));
    }
    if ((SIM_VENDORS as readonly string[]).includes(root)) {
      const mod = modules[root as SimVendor];
      if (!mod) {
        return send(req, res, json(404, { error: `/${root} is not simulated in M0` }));
      }
      const r = await vendorRoute(mod, method, url, rest, req.headers, body);
      if (opts.logRequests) {
        log(`${method} /${root}${rest} -> ${r.kind === 'drop' ? 'dropped' : r.status}`);
      }
      return send(req, res, r);
    }
    if (url.pathname === '/') {
      return send(
        req,
        res,
        json(200, {
          name: 'farm-manager vendor stand-in',
          vendors: Object.keys(modules),
          control: [
            '/_control/status',
            '/_control/clock',
            '/_control/scenario',
            '/_control/faults',
            '/_control/reset',
          ],
        }),
      );
    }
    return send(req, res, json(404, { error: 'not found' }));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log(`internal error: ${(e as Error).stack ?? String(e)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'stand-in internal error' }));
      } else {
        res.destroy();
      }
    });
  });
  server.keepAliveTimeout = 5_000;

  let port = opts.port ?? DEFAULT_VENDOR_SIM_PORT;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  const hostPart = host.includes(':') ? `[${host}]` : host;

  return {
    url: `http://${hostPart}:${port}`,
    port,
    get world() {
      return world;
    },
    counters,
    status,
    control,
    close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
