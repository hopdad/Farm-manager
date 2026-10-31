/**
 * MyGeotab client (slice 1f.2, the trucks builder; docs/contracts-1f.md part B, §B.1): JSON-RPC
 * over the shared `vendorFetch` (no SDK, no new dependency), in every mode (sim = the stand-in,
 * replay = the doc-derived fixtures told apart by body, sandbox = the free demo database on the
 * production servers, live).
 *
 *  - SESSION (./session.ts): Authenticate once with the service user (`userName` on the wire),
 *    reuse the session across runs from the token store, re-authenticate on
 *    InvalidUserException (password change, 100-session cap, server restart, expiry) and retry
 *    the call once; at most 10 Authenticate a minute. Replay skips it (a fixed session).
 *  - SERVER: LoginResult.path names the server to call from then on (a host; "ThisServer" or
 *    absent = the one we authenticated against, the configured GEOTAB_SERVER). It is kept with
 *    the session; when that server can't be reached, the client re-authenticates against the
 *    configured server and retries once.
 *  - ERRORS come back with HTTP 200 and `error.data.type`: switch on the type, never the status
 *    (OverLimitException carries Retry-After → `retryAfterSeconds`, so runSyncStep backs off).
 *  - FEEDS (the cursor/version sync model, `pollVersionFeed`): GetFeed per entity type, ONE
 *    toVersion cursor each (LogRecord → positions, StatusData → stats, FaultData → faults). A
 *    null cursor is "from now" (empty data + a toVersion); a full page means more. GetFeed at
 *    most 60/min per entity type (counted per process; the page budget shrinks before the limit).
 *  - StatusData GetFeed returns EVERY diagnostic (search is ignored): records of other
 *    diagnostics, and of vehicles the farm doesn't map (`only`), are dropped before landing.
 *  - Lookups: Diagnostic (units; SPN, OBD code, source, controller) and FailureMode (FMI) by id,
 *    cached 12 h per database, so fault items land decoded.
 *  - LIMITED SCOPE: since 11.119 GetFeed on LogRecord and StatusData throws for a user scoped to
 *    some groups. Then positions come from Get DeviceStatusInfo (last known, snapshot diff) and
 *    stats from DeviceStatusInfo's latest StatusData of our diagnostics; the client says so
 *    (`fallbacks`, logged) and probes GetFeed again after an hour.
 *
 * SANDBOX (no separate host, no developer key): create the free demo database at
 * https://my.geotab.com/registration.html ("Create a Demo Database": up to 60 days, 10-50
 * replayed vehicles, on the production servers), add a user with Authentication type "Service
 * Account" (clearance "View only", data access the root Company Group) under People > Users &
 * Drivers, then set CONNECTOR_GEOTAB=sandbox, GEOTAB_DATABASE (the demo_… name), GEOTAB_USERNAME
 * and GEOTAB_PASSWORD (GEOTAB_SERVER stays my.geotab.com; LoginResult.path redirects).
 */
import {
  type ConnectorConfig,
  type GeotabEndpoint,
  geotabEndpoint,
  REPLAY_CREDENTIAL,
  replayFetch,
} from '../endpoints';
import {
  parseRetryAfter,
  type VendorHttpOptions,
  VendorNetworkError,
  VendorResponseError,
  vendorFetch,
} from '../http';
import type { TokenStore } from '../oauth/token-store';
import { fingerprint, pollSnapshotDiff, pollVersionFeed } from '../sync-models';
import type {
  Mode,
  NormalizedVehicle,
  PollResult,
  RawItem,
  VehicleTelematicsSource,
} from '../types';
import { mapGeotabFault, mapGeotabPosition, mapGeotabStat, mapGeotabVehicle } from './mapper';
import {
  GEOTAB_NO_FAILURE_MODE,
  GEOTAB_STAT_DIAGNOSTIC_IDS,
  type GeotabDevice,
  type GeotabDeviceStatusInfo,
  type GeotabDiagnostic,
  type GeotabFailureMode,
  type GeotabFaultData,
  type GeotabFaultRaw,
  type GeotabPositionRaw,
  type GeotabRpcError,
  type GeotabStatRaw,
  type GeotabStatusData,
  type GeotabVehicleRaw,
  geotabDeviceSchema,
  geotabDeviceStatusInfoSchema,
  geotabDiagnosticSchema,
  geotabFailureModeSchema,
  geotabFaultDataSchema,
  geotabFeedResultSchema,
  geotabGetResultSchema,
  geotabGroupSchema,
  geotabLoginResultSchema,
  geotabLogRecordSchema,
  geotabRpcResponseSchema,
  geotabStatusDataSchema,
} from './schemas';
import {
  callsLeft,
  countCall,
  decodeSession,
  GEOTAB_AUTHENTICATE_PER_MINUTE,
  GEOTAB_GETFEED_PER_MINUTE,
  type GeotabSession,
  geotabSessionOrg,
  memorySessionStore,
  secondsUntilFree,
  serverFromPath,
  sessionTokens,
} from './session';

/** Records asked for per GetFeed page (Geotab's maximum is 50 000). */
export const GEOTAB_RESULTS_LIMIT = 5_000;
/** Most GetFeed pages one poll follows (a full page means more is waiting). */
export const GEOTAB_MAX_PAGES = 10;
/** How long lookups (Diagnostic, FailureMode) are reused (the Data Feed guide: 12-24 h). */
export const GEOTAB_LOOKUP_TTL_MS = 12 * 3_600_000;
/** A limited-scope user's GetFeed is tried again after this long. */
export const GEOTAB_SCOPE_RETRY_MS = 3_600_000;
/** Retry-After when an OverLimitException names none. */
const DEFAULT_OVER_LIMIT_SECONDS = 60;

export type GeotabLog = (msg: string, data?: Record<string, unknown>) => void;

/** The JSON-RPC error types the client acts on (api.json knownError). */
export const GEOTAB_ERROR_TYPES = {
  invalidUser: 'InvalidUserException',
  overLimit: 'OverLimitException',
  dbUnavailable: 'DbUnavailableException',
  missingMethod: 'MissingMethodException',
} as const;

/** A MyGeotab JSON-RPC error (or a client-side over-limit). Never carries credentials. */
export class GeotabError extends Error {
  readonly type: string;
  readonly method: string;
  readonly retryAfterSeconds?: number;
  constructor(init: {
    type: string;
    method: string;
    message?: string;
    retryAfterSeconds?: number;
  }) {
    super(`geotab ${init.method}: ${init.type}${init.message ? ` (${clip(init.message)})` : ''}`);
    this.name = 'GeotabError';
    this.type = init.type;
    this.method = init.method;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

const clip = (s: string) => (s.length > 160 ? `${s.slice(0, 157)}...` : s);

export interface GeotabClientOptions {
  /** Where the session lives (OAuthTokenStore source 'geotab'); default: a per-process store. */
  store?: TokenStore | null;
  /** Keep only these Geotab device ids (the ones the farm maps); null/undefined = all. */
  only?: ReadonlySet<string> | null;
  /** Dropped items, fallbacks, re-authentication (no secrets). */
  log?: GeotabLog;
  resultsLimit?: number;
  maxPages?: number;
}

type FeedEntity = 'LogRecord' | 'StatusData' | 'FaultData';

interface CacheEntry<T> {
  value: T | null;
  at: number;
}
const lookups = new Map<string, Map<string, CacheEntry<unknown>>>();
const limitedScope = new Map<string, number>();

/** Forget the lookup and scope caches (tests). */
export function resetGeotabCaches(): void {
  lookups.clear();
  limitedScope.clear();
}

interface ItemSchema<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false };
}

export class GeotabClient {
  readonly endpoint: GeotabEndpoint;
  private readonly http: Omit<VendorHttpOptions, 'vendor'>;
  private readonly opts: GeotabClientOptions;
  private readonly replay: boolean;
  private readonly store: TokenStore;
  private token: string | null = null;
  /** Streams served by the limited-scope fallback in this client's polls. */
  readonly fallbacks = new Set<'positions' | 'stats'>();

  constructor(
    endpoint: GeotabEndpoint,
    http: Omit<VendorHttpOptions, 'vendor'> = {},
    opts: GeotabClientOptions = {},
    replay = false,
  ) {
    this.endpoint = endpoint;
    this.http = http;
    this.opts = opts;
    this.replay = replay;
    this.store = opts.store ?? memorySessionStore(geotabSessionOrg(endpoint));
  }

  static forMode(
    mode: Mode,
    cfg: ConnectorConfig,
    http: Omit<VendorHttpOptions, 'vendor'> = {},
    opts: GeotabClientOptions = {},
  ): GeotabClient {
    if (mode === 'replay') {
      return new GeotabClient(
        geotabEndpoint(mode, cfg),
        { ...http, fetch: replayFetch('geotab', { now: http.now }) },
        opts,
        true,
      );
    }
    return new GeotabClient(geotabEndpoint(mode, cfg), http, opts);
  }

  private now(): number {
    return (this.http.now?.() ?? new Date()).getTime();
  }

  private log(msg: string, data?: Record<string, unknown>) {
    this.opts.log?.(msg, data);
  }

  private keep(deviceId: string): boolean {
    return !this.opts.only || this.opts.only.has(deviceId);
  }

  private limitKey(what: string): string {
    return `${this.endpoint.apiUrl}|${this.endpoint.database}|${this.endpoint.username}|${what}`;
  }

  /** The JSON-RPC URL for a server (null = the configured one): only the host changes. */
  urlFor(server: string | null): string {
    if (!server) return this.endpoint.apiUrl;
    const u = new URL(this.endpoint.apiUrl);
    u.host = server;
    return u.toString();
  }

  /** One JSON-RPC POST: the envelope, and the Retry-After header for an OverLimitException. */
  private async post(
    url: string,
    body: Record<string, unknown>,
  ): Promise<{ result?: unknown; error?: GeotabRpcError; retryAfter?: number }> {
    const res = await vendorFetch(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      },
      { ...this.http, vendor: 'geotab' },
    );
    const text = await res.text();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new VendorResponseError('geotab', new URL(url).pathname, 'body is not JSON');
    }
    const env = geotabRpcResponseSchema.safeParse(value);
    if (!env.success) {
      throw new VendorResponseError('geotab', new URL(url).pathname, 'not a JSON-RPC response');
    }
    return {
      result: env.data.result,
      error: env.data.error,
      retryAfter: parseRetryAfter(res.headers.get('retry-after'), new Date(this.now())),
    };
  }

  private errorOf(method: string, e: GeotabRpcError, retryAfter?: number): GeotabError {
    const type = e.data?.type ?? 'UnknownError';
    return new GeotabError({
      type,
      method,
      message: e.message,
      ...(type === GEOTAB_ERROR_TYPES.overLimit
        ? { retryAfterSeconds: retryAfter ?? DEFAULT_OVER_LIMIT_SECONDS }
        : {}),
    });
  }

  /**
   * Authenticate against the CONFIGURED server (Geotab: "authenticate against my.geotab.com
   * unless you already know the customer's server"), at most 10 a minute.
   */
  async authenticate(): Promise<GeotabSession> {
    const key = this.limitKey('Authenticate');
    const wait = secondsUntilFree(key, GEOTAB_AUTHENTICATE_PER_MINUTE, this.now());
    if (wait > 0) {
      throw new GeotabError({
        type: GEOTAB_ERROR_TYPES.overLimit,
        method: 'Authenticate',
        message: 'client-side: 10 Authenticate a minute',
        retryAfterSeconds: wait,
      });
    }
    countCall(key, this.now());
    const { database, username, password } = this.endpoint;
    const r = await this.post(this.endpoint.apiUrl, {
      method: 'Authenticate',
      params: { database, userName: username, password },
    });
    if (r.error) throw this.errorOf('Authenticate', r.error, r.retryAfter);
    const login = geotabLoginResultSchema.safeParse(r.result);
    if (!login.success) {
      throw new VendorResponseError('geotab', '/apiv1', 'Authenticate: not a LoginResult');
    }
    const server = serverFromPath(login.data.path);
    this.log('geotab: authenticated', { server: server ?? '(configured)' });
    return {
      sessionId: login.data.credentials.sessionId,
      database: login.data.credentials.database,
      userName: login.data.credentials.userName,
      server,
    };
  }

  private refresher = async () => sessionTokens(await this.authenticate(), new Date(this.now()));

  /** The session to call with: the stored one, else a new Authenticate (saved). */
  async session(): Promise<GeotabSession> {
    if (this.replay) {
      return {
        sessionId: REPLAY_CREDENTIAL,
        database: this.endpoint.database,
        userName: this.endpoint.username,
        server: null,
      };
    }
    if (!this.token) {
      this.token = await this.store.accessToken(this.refresher);
      if (!this.token) {
        const t = await this.refresher();
        await this.store.save(t);
        this.token = t.accessToken;
      }
    }
    const s = decodeSession(this.token);
    if (s) return s;
    // An unreadable stored session: start a new one.
    const t = await this.refresher();
    await this.store.save(t);
    this.token = t.accessToken;
    return decodeSession(t.accessToken) as GeotabSession;
  }

  /** The stored session was rejected (or its server is gone): re-authenticate under the lock. */
  private async renew(): Promise<GeotabSession> {
    const rejected = this.token ?? '';
    let next = await this.store.refreshAfterReject(rejected, this.refresher);
    if (!next || next === rejected) {
      const t = await this.refresher();
      await this.store.save(t);
      next = t.accessToken;
    }
    this.token = next;
    return decodeSession(next) as GeotabSession;
  }

  /** One authenticated call: re-authenticate once on InvalidUserException or a dead server. */
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    let s = await this.session();
    for (let attempt = 0; ; attempt++) {
      const credentials = { database: s.database, userName: s.userName, sessionId: s.sessionId };
      let r: Awaited<ReturnType<GeotabClient['post']>>;
      try {
        r = await this.post(this.urlFor(s.server), { method, params: { ...params, credentials } });
      } catch (e) {
        if (e instanceof VendorNetworkError && s.server && attempt === 0 && !this.replay) {
          this.log(
            'geotab: the server LoginResult.path named is unreachable; back to the configured one',
            {
              server: s.server,
            },
          );
          s = await this.renew();
          continue;
        }
        throw e;
      }
      if (r.error) {
        const type = r.error.data?.type;
        if (type === GEOTAB_ERROR_TYPES.invalidUser && attempt === 0 && !this.replay) {
          this.log('geotab: session rejected (InvalidUserException); authenticating again');
          s = await this.renew();
          continue;
        }
        throw this.errorOf(method, r.error, r.retryAfter);
      }
      return r.result;
    }
  }

  /** Get <typeName> → entities, each parsed on its own (a bad one dropped and logged). */
  async get<T>(
    typeName: string,
    item: ItemSchema<T>,
    extra: Record<string, unknown> = {},
  ): Promise<T[]> {
    const result = await this.call('Get', { typeName, ...extra });
    const arr = geotabGetResultSchema.safeParse(result);
    if (!arr.success)
      throw new VendorResponseError('geotab', '/apiv1', `Get ${typeName}: not an array`);
    return this.items(arr.data, item, typeName);
  }

  private items<T>(raw: unknown[], item: ItemSchema<T>, what: string): T[] {
    const out: T[] = [];
    for (const x of raw) {
      const r = item.safeParse(x);
      if (r.success) out.push(r.data);
      else this.log('geotab: unreadable item dropped', { entity: what, id: idOf(x) });
    }
    return out;
  }

  /** One GetFeed page of `typeName` from `fromVersion` (null = from now). */
  async getFeed(typeName: FeedEntity | 'Device', fromVersion: string | null) {
    const limit = this.opts.resultsLimit ?? GEOTAB_RESULTS_LIMIT;
    const result = await this.call('GetFeed', {
      typeName,
      resultsLimit: limit,
      ...(fromVersion ? { fromVersion } : {}),
    });
    const feed = geotabFeedResultSchema.safeParse(result);
    if (!feed.success) {
      throw new VendorResponseError('geotab', '/apiv1', `GetFeed ${typeName}: not a FeedResult`);
    }
    return {
      data: feed.data.data,
      toVersion: feed.data.toVersion ?? null,
      full: feed.data.data.length >= limit,
    };
  }

  /**
   * Page a feed from the stored toVersion with `pollVersionFeed`, within the GetFeed budget of
   * this entity type (60/min): the first page over budget throws an OverLimit with the wait;
   * later pages are left for the next run.
   */
  private async feed<T>(
    typeName: FeedEntity,
    cursor: string | null,
    toItems: (data: unknown[]) => Promise<T[]>,
  ): Promise<PollResult<T>> {
    const key = this.limitKey(`GetFeed:${typeName}`);
    const left = callsLeft(key, GEOTAB_GETFEED_PER_MINUTE, this.now());
    if (left === 0) {
      throw new GeotabError({
        type: GEOTAB_ERROR_TYPES.overLimit,
        method: 'GetFeed',
        message: `client-side: 60 GetFeed ${typeName} a minute`,
        retryAfterSeconds: secondsUntilFree(key, GEOTAB_GETFEED_PER_MINUTE, this.now()),
      });
    }
    // A snapshot-diff cursor (the limited-scope fallback's) is no version: start from now.
    const from = cursor && !cursor.startsWith('{') ? cursor : null;
    return pollVersionFeed<T>({
      cursor: from,
      maxPages: Math.min(this.opts.maxPages ?? GEOTAB_MAX_PAGES, left),
      deadline: this.http.deadline,
      signal: this.http.signal,
      now: () => new Date(this.now()),
      fetchPage: async (token) => {
        countCall(key, this.now());
        const page = await this.getFeed(typeName, token);
        return { items: await toItems(page.data), next: page.toVersion, hasMore: page.full };
      },
    });
  }

  /** Lookups by id (Diagnostic, FailureMode), cached GEOTAB_LOOKUP_TTL_MS per database. */
  private async lookup<T>(
    typeName: 'Diagnostic' | 'FailureMode',
    ids: string[],
    item: ItemSchema<T & { id: string }>,
  ) {
    const cacheKey = `${this.endpoint.apiUrl}|${this.endpoint.database}|${typeName}`;
    let cache = lookups.get(cacheKey);
    if (!cache) {
      cache = new Map();
      lookups.set(cacheKey, cache);
    }
    const now = this.now();
    const want = [...new Set(ids)];
    const missing = want.filter((id) => {
      const hit = cache.get(id);
      return !hit || now - hit.at >= GEOTAB_LOOKUP_TTL_MS;
    });
    if (missing.length) {
      const found = await this.get(typeName, item, {
        search: { ids: missing.map((id) => ({ id })) },
      });
      const byId = new Map(found.map((f) => [f.id, f]));
      for (const id of missing) cache.set(id, { value: byId.get(id) ?? null, at: now });
    }
    return new Map(want.map((id) => [id, (cache.get(id)?.value ?? null) as T | null]));
  }

  async diagnostics(ids: string[]) {
    return this.lookup<GeotabDiagnostic>(
      'Diagnostic',
      ids,
      geotabDiagnosticSchema as ItemSchema<GeotabDiagnostic>,
    );
  }

  async failureModes(ids: string[]) {
    return this.lookup<GeotabFailureMode>(
      'FailureMode',
      ids.filter((id) => id !== GEOTAB_NO_FAILURE_MODE),
      geotabFailureModeSchema as ItemSchema<GeotabFailureMode>,
    );
  }

  // ---- limited scope ----------------------------------------------------------------------

  private scopeKey(): string {
    return geotabSessionOrg(this.endpoint);
  }

  private scopeLimited(): boolean {
    const until = limitedScope.get(this.scopeKey());
    return until !== undefined && this.now() < until;
  }

  /** Is this GetFeed error the 11.119 scope restriction (not auth, limits or a busy server)? */
  private isScopeError(e: unknown): boolean {
    if (!(e instanceof GeotabError) || e.method !== 'GetFeed') return false;
    const t = e.type;
    return (
      t !== GEOTAB_ERROR_TYPES.invalidUser &&
      t !== GEOTAB_ERROR_TYPES.overLimit &&
      t !== GEOTAB_ERROR_TYPES.dbUnavailable &&
      t !== GEOTAB_ERROR_TYPES.missingMethod
    );
  }

  private markLimited(stream: 'positions' | 'stats', e: GeotabError) {
    limitedScope.set(this.scopeKey(), this.now() + GEOTAB_SCOPE_RETRY_MS);
    this.log(
      'geotab: GetFeed refused (a limited-scope service user, 11.119); using Get DeviceStatusInfo until the hauler grants whole-fleet scope',
      { stream, type: e.type },
    );
  }

  /** Get DeviceStatusInfo (every device the user sees), optionally with diagnostics' latest data. */
  async deviceStatusInfo(diagnostics?: readonly string[]): Promise<GeotabDeviceStatusInfo[]> {
    return this.get(
      'DeviceStatusInfo',
      geotabDeviceStatusInfoSchema as ItemSchema<GeotabDeviceStatusInfo>,
      diagnostics ? { search: { diagnostics: diagnostics.map((id) => ({ id })) } } : {},
    );
  }

  // ---- streams ------------------------------------------------------------------------------

  /** Stream 'positions': LogRecords since the stored toVersion (or last-known fixes, limited scope). */
  async pollPositions(cursor: string | null): Promise<PollResult<RawItem<GeotabPositionRaw>>> {
    if (!this.scopeLimited()) {
      try {
        return await this.feed('LogRecord', cursor, async (data) =>
          this.items(data, geotabLogRecordSchema, 'LogRecord')
            .filter((r) => this.keep(r.device.id))
            .sort((a, b) => Date.parse(a.dateTime) - Date.parse(b.dateTime))
            .map((record) => ({
              externalId: `${record.device.id}:${new Date(record.dateTime).toISOString()}`,
              payload: { entity: 'LogRecord' as const, record },
            })),
        );
      } catch (e) {
        if (!this.isScopeError(e)) throw e;
        this.markLimited('positions', e as GeotabError);
      }
    }
    this.fallbacks.add('positions');
    const items = (await this.deviceStatusInfo())
      .filter((r) => this.keep(r.device.id))
      .map((record) => ({
        externalId: `${record.device.id}:${new Date(record.dateTime).toISOString()}`,
        payload: { entity: 'DeviceStatusInfo' as const, record },
      }));
    const r = await pollSnapshotDiff({
      cursor,
      fetchSnapshot: async () => items,
      keyOf: (i) => i.payload.record.device.id,
      versionOf: (i) => Date.parse(i.payload.record.dateTime),
      mode: 'newer',
    });
    return { items: r.items, cursor: r.cursor, hasMore: false };
  }

  /** Our diagnostics' readings with their units (dropping every other diagnostic first). */
  private async statItems(records: GeotabStatusData[]): Promise<RawItem<GeotabStatRaw>[]> {
    const ours = records.filter(
      (r) => GEOTAB_STAT_DIAGNOSTIC_IDS.includes(r.diagnostic.id) && this.keep(r.device.id),
    );
    if (!ours.length) return [];
    const diags = await this.diagnostics(ours.map((r) => r.diagnostic.id));
    return ours.map((record) => ({
      externalId: `${record.device.id}:${record.diagnostic.id}:${new Date(record.dateTime).toISOString()}`,
      payload: { record, diagnostic: diags.get(record.diagnostic.id) ?? null },
    }));
  }

  /** Stream 'stats': StatusData since the stored toVersion, filtered to our diagnostics. */
  async pollStats(cursor: string | null): Promise<PollResult<RawItem<GeotabStatRaw>>> {
    if (!this.scopeLimited()) {
      try {
        return await this.feed('StatusData', cursor, (data) =>
          this.statItems(this.items(data, geotabStatusDataSchema, 'StatusData')),
        );
      } catch (e) {
        if (!this.isScopeError(e)) throw e;
        this.markLimited('stats', e as GeotabError);
      }
    }
    this.fallbacks.add('stats');
    const latest = (await this.deviceStatusInfo(GEOTAB_STAT_DIAGNOSTIC_IDS)).flatMap((i) =>
      this.items(i.statusData ?? [], geotabStatusDataSchema, 'StatusData'),
    );
    const items = await this.statItems(latest);
    const r = await pollSnapshotDiff({
      cursor,
      fetchSnapshot: async () => items,
      keyOf: (i) => `${i.payload.record.device.id}:${i.payload.record.diagnostic.id}`,
      versionOf: (i) => Date.parse(i.payload.record.dateTime),
      mode: 'newer',
    });
    return { items: r.items, cursor: r.cursor, hasMore: false };
  }

  /** Stream 'faults': FaultData since the stored toVersion, decoded with the lookups. */
  async pollFaults(cursor: string | null): Promise<PollResult<RawItem<GeotabFaultRaw>>> {
    return this.feed('FaultData', cursor, async (data) => {
      const records = this.items(data, geotabFaultDataSchema, 'FaultData').filter((r) =>
        this.keep(r.device.id),
      );
      if (!records.length) return [];
      const diags = await this.diagnostics(
        records.flatMap((r) => (r.diagnostic ? [r.diagnostic.id] : [])),
      );
      const fms = await this.failureModes(
        records.flatMap((r) => (r.failureMode ? [r.failureMode.id] : [])),
      );
      return records.map((record: GeotabFaultData) => ({
        externalId: `${record.device.id}:fault:${record.id}`,
        payload: {
          record,
          diagnostic: record.diagnostic ? (diags.get(record.diagnostic.id) ?? null) : null,
          failureMode: record.failureMode ? (fms.get(record.failureMode.id) ?? null) : null,
        },
      }));
    });
  }

  /** The active devices (Get Device, fromDate = now) with their group names. */
  async devices(): Promise<{ device: GeotabDevice; groups: string[] }[]> {
    const devices = await this.get('Device', geotabDeviceSchema as ItemSchema<GeotabDevice>, {
      search: { fromDate: new Date(this.now()).toISOString() },
      resultsLimit: GEOTAB_RESULTS_LIMIT,
    });
    const needGroups = devices.some((d) => (d.groups ?? []).length > 0);
    const names = new Map<string, string>();
    if (needGroups) {
      for (const g of await this.get('Group', geotabGroupSchema))
        if (g.name) names.set(g.id, g.name);
    }
    return devices.map((device) => ({
      device,
      groups: (device.groups ?? []).flatMap((g) => {
        const n = names.get(g.id);
        return n ? [n] : [];
      }),
    }));
  }

  /** Stream 'vehicles': each device whose name, groups or VIN changed. */
  async pollVehicles(cursor: string | null): Promise<PollResult<RawItem<GeotabVehicleRaw>>> {
    // The poll time in the id (as fleet.vehicles and fleet.terminal do): a device back at an
    // earlier version (groups A → B → A) lands again instead of being dropped by raw_events'
    // dedupe; only versions that moved are emitted, so nothing lands twice.
    const at = this.now();
    const items: RawItem<GeotabVehicleRaw>[] = [];
    for (const { device, groups } of await this.devices()) {
      if (!this.keep(device.id)) continue;
      const payload: GeotabVehicleRaw = { device, groups: [...groups].sort() };
      items.push({ externalId: `${device.id}:vehicle:${deviceVersion(payload)}:${at}`, payload });
    }
    const r = await pollSnapshotDiff({
      cursor,
      fetchSnapshot: async () => items,
      keyOf: (i) => i.payload.device.id,
      versionOf: (i) => deviceVersion(i.payload),
      mode: 'changed',
    });
    return { items: r.items, cursor: r.cursor, hasMore: false };
  }

  /** The port (src/connectors/types.ts VehicleTelematicsSource), mapped. */
  asTelematicsSource(
    opts: { kindTags?: Parameters<typeof mapGeotabVehicle>[1] } = {},
  ): Required<VehicleTelematicsSource> {
    return {
      positions: async (cursor) => {
        const r = await this.pollPositions(cursor);
        return { ...r, items: r.items.flatMap((i) => mapGeotabPosition(i.payload)) };
      },
      stats: async (cursor) => {
        const r = await this.pollStats(cursor);
        return { ...r, items: r.items.flatMap((i) => mapGeotabStat(i.payload)) };
      },
      faults: async (cursor) => {
        const r = await this.pollFaults(cursor);
        return { ...r, items: r.items.flatMap((i) => mapGeotabFault(i.payload)) };
      },
      vehicles: async (): Promise<NormalizedVehicle[]> =>
        (await this.devices()).flatMap(({ device, groups }) =>
          mapGeotabVehicle({ device, groups }, opts.kindTags),
        ),
    };
  }
}

function deviceVersion(p: GeotabVehicleRaw): string {
  const d = p.device;
  return fingerprint(
    JSON.stringify([d.name ?? null, p.groups, d.vehicleIdentificationNumber ?? null]),
  );
}

/** The id of an unreadable item, for the log (never its whole body). */
function idOf(raw: unknown): string | null {
  const id = (raw as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : null;
}
