/**
 * Terminal client (slice 1f.2, the terminal-pickups builder; docs/contracts-1f.md part B §B.1):
 * the vehicle telematics port over Terminal's normalized API, in every mode (sim = the stand-in,
 * replay = the doc-derived fixtures, sandbox/live = Terminal; sandbox needs Terminal's grant).
 *
 * Every call sends `Authorization: Bearer <secret key>`; the hauler's data calls add
 * `Connection-Token: <token>`. CONNECTIONS ARE DISCOVERED: `GET /connections?status=connected`
 * (the secret key alone lists them, one per hauler, each row with its own `token`; tokens don't
 * expire unless rotated), cached for TERMINAL_CONNECTIONS_TTL_MS; TERMINAL_CONNECTION_TOKEN only
 * pins one (`GET /connections/current` names it). Each connection's id is the external_refs
 * `source_org` of its vehicles. A connection Terminal refuses (403, or 410/422: deleted,
 * disconnected, credentials) is skipped and logged, never the others; the cache is dropped so
 * the next run rediscovers.
 *
 * Streams (the job's; src/jobs/fleet-terminal.ts):
 *   positions  HISTORY `GET /vehicles/{id}/locations` per vehicle (Terminal's own sync, which
 *              lags: every run re-queries a TERMINAL_LOOKBACK_HOURS window, as Terminal advises,
 *              and emits the breadcrumbs Terminal stored since the last run: a per-vehicle
 *              watermark on `metadata.modifiedAt`) as `live`, then LATEST `GET /vehicles/locations`
 *              (≤ 50 `vehicleIds` a call; a live call to the provider) as `last_known`
 *              (snapshot diff, `newer` by `locatedAt`). History lands first in a run, so the
 *              §5.0 precedence keeps the live badge while history is fresh.
 *   stats      `GET /vehicles/{id}/stats/historical` (same lookback and watermark), then the
 *              counters of the latest location when they change
 *   faults     `GET /fault-codes/events?modifiedAfter=` per connection (Terminal's ingestion
 *              time is the cursor; the first run looks back DELTA_FAULT_AGE_OUT_SECONDS)
 *   vehicles   `GET /vehicles?expand=groups` (group names are the only kind hint)
 *   providers  `GET /providers` (no key needed): the providers behind our connections
 *
 * Only the vehicles the farm maps are asked for and landed (`only`: external refs per connection;
 * vehicle creation from a vendor list is not in 1f.2). Items the lenient schemas can't read are
 * dropped and logged with their id (§B.5). A 429's Retry-After may be fractional (vendorFetch
 * rounds it up).
 */
import type { z } from 'zod';
import { DELTA_FAULT_AGE_OUT_SECONDS } from '../../domain/fault-codes';
import type { VehicleKindTagRule } from '../../domain/vehicles';
import {
  type ConnectorConfig,
  replayFetch,
  type TerminalEndpoint,
  terminalEndpoint,
} from '../endpoints';
import { VendorHttpError, type VendorHttpOptions, vendorJson } from '../http';
import { fingerprint, pollSnapshotDiff } from '../sync-models';
import type {
  Mode,
  NormalizedVehicle,
  PollResult,
  RawItem,
  VehicleTelematicsSource,
} from '../types';
import {
  mapTerminalFault,
  mapTerminalPosition,
  mapTerminalStat,
  mapTerminalVehicle,
} from './mapper';
import {
  expandedId,
  TERMINAL_STAT_TYPES,
  type TerminalConnection,
  type TerminalFaultEvent,
  type TerminalFaultRaw,
  type TerminalHistoricalLocation,
  type TerminalLatestLocation,
  type TerminalPositionRaw,
  type TerminalProvider,
  type TerminalProvidersRaw,
  type TerminalStatLog,
  type TerminalStatRaw,
  type TerminalVehicle,
  type TerminalVehicleRaw,
  terminalConnectionSchema,
  terminalCurrentConnectionSchema,
  terminalFaultEventSchema,
  terminalHistoricalLocationSchema,
  terminalLatestLocationSchema,
  terminalListSchema,
  terminalProviderSchema,
  terminalProvidersSchema,
  terminalStatLogSchema,
  terminalVehicleSchema,
} from './schemas';

/** Terminal's advice: re-query a 24-48 h trailing window of history every run. */
export const TERMINAL_LOOKBACK_HOURS = 24;
/** `vehicleIds` takes at most 50 ids a call (latest locations, fault events). */
export const TERMINAL_MAX_IDS = 50;
/** Most pages one list read follows (Terminal documents no page size: rely on `next`). */
export const TERMINAL_MAX_PAGES = 50;
/** How long discovered connections are reused before GET /connections is asked again. */
export const TERMINAL_CONNECTIONS_TTL_MS = 5 * 60_000;
/** A latest-locations read younger than this is reused by the next stream of the run. */
export const TERMINAL_LATEST_TTL_MS = 5_000;

export type TerminalLog = (msg: string, data?: Record<string, unknown>) => void;

/** One hauler's connection, as the client uses it. */
export interface TerminalConnectionRef {
  /** `conn_…`: the external_refs source_org. */
  id: string;
  token: string;
  providerCode: string;
  providerName: string | null;
}

export interface TerminalClientOptions {
  /**
   * The vehicle ids the farm maps, per connection id; a connection with none is not asked for
   * vehicle data. null/undefined = every vehicle of every connection (GET /vehicles lists them).
   */
  only?: ReadonlyMap<string, ReadonlySet<string>> | null;
  /** Dropped items, skipped connections (no secrets). */
  log?: TerminalLog;
  lookbackHours?: number;
  latestTtlMs?: number;
}

const connectionCache = new Map<string, { at: number; refs: TerminalConnectionRef[] }>();

/** Forget every discovered connection (tests; a token rotation). */
export function forgetTerminalConnections(): void {
  connectionCache.clear();
}

/** Statuses after which a connection's data is out of reach until someone reconnects it. */
const CONNECTION_REFUSED = new Set([403, 410, 422]);

interface ItemSchema<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false };
}

/** A per-vehicle watermark cursor: `{"v":1,"marks":{…},"latest":"<snapshot cursor>"}`. */
interface MarkCursor {
  v: 1;
  marks: Record<string, string>;
  latest: string | null;
}

export function parseMarkCursor(cursor: string | null): MarkCursor {
  try {
    const p = JSON.parse(cursor ?? '') as Partial<MarkCursor> | null;
    if (p?.v !== 1 || !p.marks || typeof p.marks !== 'object' || Array.isArray(p.marks)) {
      return { v: 1, marks: {}, latest: null };
    }
    const marks: Record<string, string> = {};
    for (const [k, val] of Object.entries(p.marks)) if (typeof val === 'string') marks[k] = val;
    return { v: 1, marks, latest: typeof p.latest === 'string' ? p.latest : null };
  } catch {
    return { v: 1, marks: {}, latest: null };
  }
}

type LatestStatRaw = Extract<TerminalStatRaw, { kind: 'latest' }>;

const keyOf = (connectionId: string, vehicleId: string) => `${connectionId}|${vehicleId}`;
const ms = (s: string) => Date.parse(s);
const chunks = <T>(xs: readonly T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

export class TerminalClient {
  readonly endpoint: TerminalEndpoint;
  private readonly http: Omit<VendorHttpOptions, 'vendor'>;
  private readonly opts: TerminalClientOptions;
  private latest = new Map<string, { at: number; items: TerminalLatestLocation[] }>();

  constructor(
    endpoint: TerminalEndpoint,
    http: Omit<VendorHttpOptions, 'vendor'> = {},
    opts: TerminalClientOptions = {},
  ) {
    this.endpoint = endpoint;
    this.http = http;
    this.opts = opts;
  }

  /** The client for a connector mode; replay = this client on the doc-derived fixtures. */
  static forMode(
    mode: Mode,
    cfg: ConnectorConfig,
    http: Omit<VendorHttpOptions, 'vendor'> = {},
    opts: TerminalClientOptions = {},
  ): TerminalClient {
    if (mode === 'replay') {
      return new TerminalClient(
        terminalEndpoint(mode, cfg),
        { ...http, fetch: replayFetch('terminal', { now: http.now }) },
        opts,
      );
    }
    return new TerminalClient(terminalEndpoint(mode, cfg), http, opts);
  }

  private now(): number {
    return (this.http.now?.() ?? new Date()).getTime();
  }

  private log(msg: string, data?: Record<string, unknown>) {
    this.opts.log?.(msg, data);
  }

  private get cacheKey(): string {
    const pin = this.endpoint.connectionToken;
    return `${this.endpoint.baseUrl}|${fingerprint(this.endpoint.secretKey)}|${pin ? fingerprint(pin) : ''}`;
  }

  /** GET one Terminal path (secrets ride in headers, never in the query). */
  private get<T>(
    schema: z.ZodType,
    path: string,
    query: Record<string, string> = {},
    connectionToken?: string,
  ): Promise<T> {
    const u = new URL(`${this.endpoint.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return vendorJson(
      schema,
      u.toString(),
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.endpoint.secretKey}`,
          accept: 'application/json',
          ...(connectionToken ? { 'connection-token': connectionToken } : {}),
        },
      },
      { ...this.http, vendor: 'terminal' },
    ) as Promise<T>;
  }

  /** Every page of a `{ results, next? }` list (follow `next` as `cursor`; never the count). */
  private async list<T>(
    path: string,
    item: ItemSchema<T>,
    query: Record<string, string> = {},
    connectionToken?: string,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < TERMINAL_MAX_PAGES; page++) {
      const body: z.infer<typeof terminalListSchema> = await this.get(
        terminalListSchema,
        path,
        cursor ? { ...query, cursor } : query,
        connectionToken,
      );
      for (const raw of body.results) {
        const r = item.safeParse(raw);
        if (r.success) out.push(r.data);
        else this.log('terminal: unreadable item dropped', { path, id: idOf(raw) });
      }
      if (!body.next || body.next === cursor) return out;
      cursor = body.next;
    }
    this.log('terminal: list cut at the page limit', { path, pages: TERMINAL_MAX_PAGES });
    return out;
  }

  // ---- connections ----------------------------------------------------------------------------

  /** The connections to read (discovered, or the pinned one), cached TERMINAL_CONNECTIONS_TTL_MS. */
  async connections(): Promise<TerminalConnectionRef[]> {
    const hit = connectionCache.get(this.cacheKey);
    if (hit && this.now() - hit.at < TERMINAL_CONNECTIONS_TTL_MS) return hit.refs;
    const refs = this.endpoint.connectionToken
      ? [await this.pinnedConnection(this.endpoint.connectionToken)]
      : (
          await this.list(
            '/connections',
            terminalConnectionSchema as ItemSchema<TerminalConnection>,
            { status: 'connected' },
          )
        )
          // The filter is the server's; a stand-in or a proxy that ignores it still can't hand
          // us a disconnected hauler.
          .filter((c) => !c.status || c.status === 'connected')
          .map(refOf);
    if (!refs.length) this.log('terminal: no connected connection (send a hauler the Link)');
    connectionCache.set(this.cacheKey, { at: this.now(), refs });
    return refs;
  }

  private async pinnedConnection(token: string): Promise<TerminalConnectionRef> {
    const c = await this.get<z.infer<typeof terminalCurrentConnectionSchema>>(
      terminalCurrentConnectionSchema,
      '/connections/current',
      {},
      token,
    );
    return refOf({ ...c, token });
  }

  /**
   * Run `fn` for each connection; a connection Terminal refuses (403/410/422) is skipped and
   * logged (the others still run); when every connection was refused, the last refusal throws.
   */
  private async perConnection<T>(fn: (c: TerminalConnectionRef) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    let refused: VendorHttpError | null = null;
    let ok = 0;
    const conns = await this.connections();
    for (const c of conns) {
      try {
        out.push(...(await fn(c)));
        ok++;
      } catch (e) {
        if (e instanceof VendorHttpError && CONNECTION_REFUSED.has(e.status)) {
          refused = e;
          connectionCache.delete(this.cacheKey);
          this.log('terminal: connection skipped (Terminal refused it; reconnect it in Link)', {
            connectionId: c.id,
            status: e.status,
            detail: e.detail,
          });
          continue;
        }
        throw e;
      }
    }
    if (refused && ok === 0) throw refused;
    return out;
  }

  /** The vehicle ids to ask for on a connection (the mapped ones; every one without `only`). */
  async vehicleIds(c: TerminalConnectionRef): Promise<string[]> {
    if (this.opts.only) return [...(this.opts.only.get(c.id) ?? [])].sort();
    return (await this.vehicles(c)).map((v) => v.id);
  }

  private keep(c: TerminalConnectionRef, vehicleId: string): boolean {
    return !this.opts.only || (this.opts.only.get(c.id)?.has(vehicleId) ?? false);
  }

  // ---- calls ----------------------------------------------------------------------------------

  /** GET /providers: every provider Terminal integrates, with its supported models. */
  async providers(): Promise<TerminalProvider[]> {
    const body = await this.get<unknown[]>(terminalProvidersSchema, '/providers');
    const out: TerminalProvider[] = [];
    for (const raw of body) {
      const r = terminalProviderSchema.safeParse(raw);
      if (r.success) out.push(r.data);
      else
        this.log('terminal: unreadable provider dropped', {
          code: (raw as { code?: unknown })?.code,
        });
    }
    return out;
  }

  /** GET /vehicles?expand=groups for one connection. */
  vehicles(c: TerminalConnectionRef): Promise<TerminalVehicle[]> {
    return this.list(
      '/vehicles',
      terminalVehicleSchema as ItemSchema<TerminalVehicle>,
      { expand: 'groups' },
      c.token,
    );
  }

  /** GET /vehicles/locations for these vehicles (≤ 50 a call), reused for TERMINAL_LATEST_TTL_MS. */
  async latestLocations(
    c: TerminalConnectionRef,
    ids: string[],
  ): Promise<TerminalLatestLocation[]> {
    if (!ids.length) return [];
    const key = `${c.id}|${ids.join(',')}`;
    const ttl = this.opts.latestTtlMs ?? TERMINAL_LATEST_TTL_MS;
    const hit = this.latest.get(key);
    if (hit && this.now() - hit.at < ttl) return hit.items;
    const items: TerminalLatestLocation[] = [];
    for (const part of chunks(ids, TERMINAL_MAX_IDS)) {
      items.push(
        ...(await this.list(
          '/vehicles/locations',
          terminalLatestLocationSchema as ItemSchema<TerminalLatestLocation>,
          { vehicleIds: part.join(',') },
          c.token,
        )),
      );
    }
    this.latest.set(key, { at: this.now(), items });
    return items;
  }

  /** GET /vehicles/{id}/locations from `startAt` (record time). */
  historicalLocations(
    c: TerminalConnectionRef,
    vehicleId: string,
    startAt: string,
  ): Promise<TerminalHistoricalLocation[]> {
    return this.list(
      `/vehicles/${encodeURIComponent(vehicleId)}/locations`,
      terminalHistoricalLocationSchema as ItemSchema<TerminalHistoricalLocation>,
      { startAt },
      c.token,
    );
  }

  /** GET /vehicles/{id}/stats/historical for the types the app reads, from `startAt`. */
  historicalStats(
    c: TerminalConnectionRef,
    vehicleId: string,
    startAt: string,
  ): Promise<TerminalStatLog[]> {
    return this.list(
      `/vehicles/${encodeURIComponent(vehicleId)}/stats/historical`,
      terminalStatLogSchema as ItemSchema<TerminalStatLog>,
      { types: TERMINAL_STAT_TYPES.join(','), startAt },
      c.token,
    );
  }

  /** GET /fault-codes/events modified after `modifiedAfter` for these vehicles (≤ 50 a call). */
  async faultEvents(
    c: TerminalConnectionRef,
    ids: string[],
    modifiedAfter: string,
  ): Promise<TerminalFaultEvent[]> {
    const out: TerminalFaultEvent[] = [];
    for (const part of chunks(ids, TERMINAL_MAX_IDS)) {
      out.push(
        ...(await this.list(
          '/fault-codes/events',
          terminalFaultEventSchema as ItemSchema<TerminalFaultEvent>,
          { modifiedAfter, vehicleIds: part.join(',') },
          c.token,
        )),
      );
    }
    return out;
  }

  private lookbackStart(): string {
    const h = this.opts.lookbackHours ?? TERMINAL_LOOKBACK_HOURS;
    return new Date(this.now() - h * 3_600_000).toISOString();
  }

  // ---- streams --------------------------------------------------------------------------------

  /**
   * Stream 'positions': per vehicle, the history breadcrumbs Terminal stored since the last run
   * (live), then each vehicle's latest location when it moved on (last_known).
   */
  async pollPositions(cursor: string | null): Promise<PollResult<RawItem<TerminalPositionRaw>>> {
    const c = parseMarkCursor(cursor);
    const startAt = this.lookbackStart();
    const latest: RawItem<TerminalPositionRaw>[] = [];
    const history = await this.perConnection(async (conn) => {
      const ids = await this.vehicleIds(conn);
      // Watermarks move only once every call of this connection answered (a refused connection
      // re-reads its breadcrumbs next run).
      const marks = { ...c.marks };
      const items: RawItem<TerminalPositionRaw>[] = [];
      for (const id of ids) {
        const locs = await this.historicalLocations(conn, id, startAt);
        const fresh = sinceMark(marks, keyOf(conn.id, id), locs, (l) => l.metadata.modifiedAt);
        for (const l of fresh.sort((a, b) => ms(a.locatedAt) - ms(b.locatedAt))) {
          if (expandedId(l.vehicle) !== id) continue;
          const ts = new Date(l.locatedAt).toISOString();
          items.push({
            externalId: `${id}:hist:${ts}:${l.id}`,
            payload: { connectionId: conn.id, kind: 'history', location: l },
          });
        }
      }
      for (const l of await this.latestLocations(conn, ids)) {
        const id = expandedId(l.vehicle);
        if (!this.keep(conn, id)) continue;
        const ts = new Date(l.locatedAt).toISOString();
        latest.push({
          externalId: `${id}:latest:${ts}`,
          payload: { connectionId: conn.id, kind: 'latest', location: l },
        });
      }
      Object.assign(c.marks, marks);
      return items;
    });
    const diff = await pollSnapshotDiff({
      cursor: c.latest,
      fetchSnapshot: async () => latest,
      keyOf: (i) => keyOf(i.payload.connectionId, expandedId(i.payload.location.vehicle)),
      versionOf: (i) => ms(i.payload.location.locatedAt),
      mode: 'newer',
    });
    return {
      // History first: runSyncStep processes a run's events in external-id order, and every
      // `…:hist:…` id of a vehicle sorts before its `…:latest:…` one.
      items: [...history, ...diff.items],
      cursor: JSON.stringify({ v: 1, marks: c.marks, latest: diff.cursor } satisfies MarkCursor),
      hasMore: false,
    };
  }

  /** Stream 'stats': the stat logs Terminal stored since the last run, then the latest counters. */
  async pollStats(cursor: string | null): Promise<PollResult<RawItem<TerminalStatRaw>>> {
    const c = parseMarkCursor(cursor);
    const startAt = this.lookbackStart();
    const latest: RawItem<LatestStatRaw>[] = [];
    const logs = await this.perConnection(async (conn) => {
      const ids = await this.vehicleIds(conn);
      const marks = { ...c.marks };
      const items: RawItem<TerminalStatRaw>[] = [];
      for (const id of ids) {
        const all = await this.historicalStats(conn, id, startAt);
        const fresh = sinceMark(marks, keyOf(conn.id, id), all, (l) => l.metadata.modifiedAt);
        for (const l of fresh.sort((a, b) => ms(a.timestamp) - ms(b.timestamp))) {
          if (expandedId(l.vehicle) !== id) continue;
          if (!(TERMINAL_STAT_TYPES as readonly string[]).includes(l.type)) continue;
          const ts = new Date(l.timestamp).toISOString();
          items.push({
            externalId: `${id}:log:${ts}:${l.id}`,
            payload: { connectionId: conn.id, kind: 'log', log: l },
          });
        }
      }
      for (const l of await this.latestLocations(conn, ids)) {
        const id = expandedId(l.vehicle);
        if (!this.keep(conn, id) || latestStatValues(l).every((v) => v === null)) continue;
        latest.push({
          externalId: `${id}:stats:${new Date(l.locatedAt).toISOString()}`,
          payload: { connectionId: conn.id, kind: 'latest', location: l },
        });
      }
      Object.assign(c.marks, marks);
      return items;
    });
    const diff = await pollSnapshotDiff({
      cursor: c.latest,
      fetchSnapshot: async () => latest,
      keyOf: (i) => keyOf(i.payload.connectionId, expandedId(i.payload.location.vehicle)),
      versionOf: (i) => JSON.stringify(latestStatValues(i.payload.location)),
      mode: 'changed',
    });
    return {
      items: [...logs, ...diff.items],
      cursor: JSON.stringify({ v: 1, marks: c.marks, latest: diff.cursor } satisfies MarkCursor),
      hasMore: false,
    };
  }

  /**
   * Stream 'faults': the fault events Terminal stored since the last run, per connection (the
   * `modifiedAfter` watermark is Terminal's ingestion time); the first run looks back one
   * age-out window (an older open fault would be aged out anyway, decision 1f-12).
   */
  async pollFaults(cursor: string | null): Promise<PollResult<RawItem<TerminalFaultRaw>>> {
    const c = parseMarkCursor(cursor);
    const first = new Date(this.now() - DELTA_FAULT_AGE_OUT_SECONDS * 1000).toISOString();
    const items = await this.perConnection(async (conn) => {
      const ids = await this.vehicleIds(conn);
      if (!ids.length) return [];
      const mark = c.marks[conn.id] ?? first;
      const events = await this.faultEvents(conn, ids, mark);
      let newest = mark;
      const out: RawItem<TerminalFaultRaw>[] = [];
      for (const e of events.sort((a, b) => ms(a.observedAt) - ms(b.observedAt))) {
        if (ms(e.metadata.modifiedAt) > ms(newest)) newest = e.metadata.modifiedAt;
        const id = expandedId(e.vehicle);
        if (!this.keep(conn, id)) continue;
        out.push({
          externalId: `${id}:fault:${new Date(e.observedAt).toISOString()}:${e.id}`,
          payload: { connectionId: conn.id, event: e },
        });
      }
      c.marks[conn.id] = newest;
      return out;
    });
    return {
      items,
      cursor: JSON.stringify({ v: 1, marks: c.marks, latest: null } satisfies MarkCursor),
      hasMore: false,
    };
  }

  /** Every mapped vehicle of every connection, with its group names. */
  async vehicleList(): Promise<TerminalVehicleRaw[]> {
    return this.perConnection(async (conn) =>
      (await this.vehicles(conn))
        .filter((v) => this.keep(conn, v.id))
        .map((vehicle) => ({ connectionId: conn.id, vehicle, groups: groupNames(vehicle) })),
    );
  }

  /** Stream 'vehicles': each mapped vehicle whose name, groups, make, model, year or VIN changed. */
  async pollVehicles(cursor: string | null): Promise<PollResult<RawItem<TerminalVehicleRaw>>> {
    // The poll time in the id: a vehicle back at an earlier version (A → B → A) lands again
    // instead of being dropped by raw_events' dedupe; only versions that moved are emitted.
    const at = this.now();
    const items = (await this.vehicleList()).map((payload) => ({
      externalId: `${payload.vehicle.id}:vehicle:${vehicleVersion(payload)}:${at}`,
      payload,
    }));
    const r = await pollSnapshotDiff({
      cursor,
      fetchSnapshot: async () => items,
      keyOf: (i) => keyOf(i.payload.connectionId, i.payload.vehicle.id),
      versionOf: (i) => vehicleVersion(i.payload),
      mode: 'changed',
    });
    return { items: r.items, cursor: r.cursor, hasMore: false };
  }

  /**
   * Stream 'providers': ONE raw item when the list moved since the last run (the cursor is its
   * fingerprint): the /providers entries of the providers our connections use.
   */
  async pollProviders(cursor: string | null): Promise<PollResult<RawItem<TerminalProvidersRaw>>> {
    const conns = await this.connections();
    const codes = [...new Set(conns.map((c) => c.providerCode))].sort();
    const want = new Set(codes);
    const providers = (await this.providers())
      .filter((p) => want.has(p.code))
      .sort((a, b) => a.code.localeCompare(b.code));
    const payload: TerminalProvidersRaw = { codes, providers };
    // The cursor is the list's fingerprint: emitted only when it moved, with the poll time in the
    // id, so a list back at an earlier state (A → B → A) still lands and replaces the rows.
    const fp = fingerprint(JSON.stringify(payload));
    if (fp === cursor) return { items: [], cursor, hasMore: false };
    return {
      items: [{ externalId: `providers:${fp}:${this.now()}`, payload }],
      cursor: fp,
      hasMore: false,
    };
  }

  /** The port (src/connectors/types.ts VehicleTelematicsSource), mapped. */
  asTelematicsSource(
    opts: { kindTags?: readonly VehicleKindTagRule[] } = {},
  ): Required<VehicleTelematicsSource> {
    return {
      positions: async (cursor) => {
        const r = await this.pollPositions(cursor);
        return { ...r, items: r.items.flatMap((i) => mapTerminalPosition(i.payload)) };
      },
      stats: async (cursor) => {
        const r = await this.pollStats(cursor);
        return { ...r, items: r.items.flatMap((i) => mapTerminalStat(i.payload)) };
      },
      faults: async (cursor) => {
        const r = await this.pollFaults(cursor);
        return { ...r, items: r.items.flatMap((i) => mapTerminalFault(i.payload)) };
      },
      vehicles: async (): Promise<NormalizedVehicle[]> =>
        (await this.vehicleList()).flatMap((v) => mapTerminalVehicle(v, opts.kindTags)),
    };
  }
}

function refOf(c: {
  id: string;
  token?: string;
  provider: { code: string; name?: string | null };
}): TerminalConnectionRef {
  return {
    id: c.id,
    token: c.token ?? '',
    providerCode: c.provider.code,
    providerName: c.provider.name ?? null,
  };
}

/**
 * The items stored after the key's watermark (by `metadata.modifiedAt`), and the watermark moved
 * to the newest one seen (in `marks`, mutated).
 */
function sinceMark<T>(
  marks: Record<string, string>,
  key: string,
  items: readonly T[],
  modifiedAt: (item: T) => string,
): T[] {
  const mark = marks[key];
  const after = mark ? ms(mark) : Number.NEGATIVE_INFINITY;
  let newest = mark;
  const out: T[] = [];
  for (const item of items) {
    const at = ms(modifiedAt(item));
    if (!Number.isFinite(at) || at <= after) continue;
    out.push(item);
    if (newest === undefined || at > ms(newest)) newest = modifiedAt(item);
  }
  if (newest !== undefined) marks[key] = newest;
  return out;
}

/** The counters of a latest location (null when absent), in a fixed order. */
function latestStatValues(l: TerminalLatestLocation): (number | string | null)[] {
  return [
    l.engineRuntime ?? null,
    l.odometer ?? null,
    l.fuel?.primaryPercentage ?? null,
    l.engineState ?? null,
  ];
}

/** A vehicle's group names (expanded groups only: a bare id names nothing). */
function groupNames(v: TerminalVehicle): string[] {
  return (v.groups ?? []).flatMap((g) => (typeof g === 'string' || !g.name ? [] : [g.name])).sort();
}

function vehicleVersion(p: TerminalVehicleRaw): string {
  const v = p.vehicle;
  return fingerprint(
    JSON.stringify([
      v.name ?? null,
      p.groups,
      v.make ?? null,
      v.model ?? null,
      v.year ?? null,
      v.vin ?? null,
    ]),
  );
}

/** The id of an unreadable item, for the log (never its whole body). */
function idOf(raw: unknown): string | null {
  const id = (raw as { id?: unknown } | null)?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}
