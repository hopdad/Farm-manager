/**
 * Deere live client (sim mode = this client against `${VENDOR_SIM_URL}/deere`).
 *
 * Every call carries a bearer token from the OAuth token store; a 401 refreshes once under the
 * advisory lock (another caller may already have) and retries. Collections follow `nextPage`
 * links. In sim mode, a missing grant is created with the stand-in's unattended consent
 * (`simAutoConnect`), at most once per poll, so `pnpm dev` runs with no clicks; in sandbox/live
 * a missing grant fails the step with "sign in at /api/oauth/deere".
 *
 * Locations: orgs → machines per org (the Equipment API: `GET {equipmentBase}/equipment?
 * organizationIds=<org>&categories=Machine&capableOf=Connectivity`, `Accept: application/json`;
 * the /platform machines API is deprecated) → breadcrumbs per machine's `principalId` (≠ its
 * organization-equipment `id`) for (cursor, now]. The cursor is the ISO end of the last window
 * (wall clock). A first run looks back `firstLookbackMs`. The client keeps only breadcrumbs inside
 * the window it asked for (Deere doesn't say whether startDate/endDate are inclusive, and a
 * replayed fixture holds a whole period).
 *
 * Paging: a first request asks for the largest page (`itemLimit=100` on /platform, whose default
 * is 10; 5000 on the Equipment API), then follows `nextPage` links (`?pageOffset=&itemLimit=`),
 * resolved against the page they came from (the Equipment API's links may be relative), at most
 * MAX_PAGES pages; a collection cut short there is reported through `onTruncated`.
 *
 * Fields, boundaries, field operations (with measurements and coverage) and flags are read by
 * the 1f syncs; in 1a they back the doc-derived replay fixtures and their contract tests.
 *
 * 1f seam (docs/contracts-1f.md §5): `apiUrl`, `getOne` and `getPaged` are public, so each 1f
 * builder adds its own Deere calls (farms, equipment, hours, operations …) in its own files,
 * with the same bearer token, 401 refresh and paging as the calls below. Their signatures are a
 * contract: change them only through the integrator.
 *
 * Replay (CONNECTOR_DEERE=replay, contracts-m1 §10): `DeereClient.forReplay()` is this same
 * client with the fixture transport and a fixed token (no OAuth: there is no token endpoint to
 * talk to).
 */
import type { ZodType, z } from 'zod';
import {
  type ConnectorConfig,
  type DeereEndpoints,
  deereEndpoints,
  REPLAY_CREDENTIAL,
  replayFetch,
} from '../endpoints';
import { VendorHttpError, vendorJson } from '../http';
import { OAuthReconnectError, type TokenRefresher, type TokenStore } from '../oauth/token-store';
import type { ReplayFixture } from '../replay';
import type { Mode, PollResult, PositionSource, RawItem } from '../types';
import { deereBreadcrumbItems, mapDeereBreadcrumb } from './mapper';
import { type DeereHttpOptions, refreshDeereTokens, simAutoConnect } from './oauth';
import {
  DEERE_EQUIPMENT_MEDIA_TYPE,
  DEERE_MEDIA_TYPE,
  type DeereBoundary,
  type DeereBreadcrumb,
  type DeereBreadcrumbRaw,
  type DeereEquipment,
  type DeereField,
  type DeereFieldOperation,
  type DeereFieldOperationMeasurement,
  type DeereFlag,
  type DeereLink,
  type DeereOrganization,
  deereBoundariesSchema,
  deereBoundarySchema,
  deereBreadcrumbsSchema,
  deereEquipmentListSchema,
  deereFieldOperationMeasurementsSchema,
  deereFieldOperationsSchema,
  deereFieldsSchema,
  deereFlagsSchema,
  deereOrganizationsSchema,
} from './schemas';

/** Pages followed per collection before giving up (a runaway `nextPage` loop). */
const MAX_PAGES = 50;
/** The largest page /platform serves ("multiples of 10 up to 100"; the default is 10). */
export const DEERE_PLATFORM_PAGE_LIMIT = 100;
/** The largest page the Equipment API serves (default 100, max 5000). */
export const DEERE_EQUIPMENT_PAGE_LIMIT = 5000;

/** Options of one GET (public 1f seam). */
export interface DeereGetOptions {
  /** Accept header (default the platform's DEERE_MEDIA_TYPE; the Equipment API takes application/json). */
  accept?: string;
  /** getPaged: the first request's `itemLimit` when the URL names none (default 100). */
  itemLimit?: number;
}

export interface DeereClientOptions {
  endpoints: DeereEndpoints;
  tokens: TokenStore;
  http?: DeereHttpOptions;
  /** Sim only: create the grant with the stand-in's unattended consent. Default true. */
  autoConnect?: boolean;
  /** First poll (no cursor) looks back this far. Default 10 min. */
  firstLookbackMs?: number;
  /** A cursor older than this resumes from now − this. Default 1 h. */
  maxLookbackMs?: number;
  /** Told when a collection had more than MAX_PAGES pages (what was read is still returned). */
  onTruncated?: (url: string, pages: number) => void;
}

type CollectionOf<T extends ZodType> = z.infer<T> & { links: DeereLink[] };

export class DeereClient {
  readonly endpoints: DeereEndpoints;
  private readonly tokens: TokenStore;
  private readonly http: DeereHttpOptions;
  private readonly autoConnect: boolean;
  private readonly firstLookbackMs: number;
  private readonly maxLookbackMs: number;
  private readonly onTruncated: (url: string, pages: number) => void;
  private connectedThisPoll = false;

  constructor(opts: DeereClientOptions) {
    this.endpoints = opts.endpoints;
    this.tokens = opts.tokens;
    this.http = opts.http ?? {};
    this.autoConnect = opts.autoConnect ?? true;
    this.firstLookbackMs = opts.firstLookbackMs ?? 10 * 60_000;
    this.maxLookbackMs = opts.maxLookbackMs ?? 60 * 60_000;
    this.onTruncated =
      opts.onTruncated ??
      ((url, pages) =>
        console.warn(`[deere] ${pathOfUrl(url)}: more than ${pages} pages; the rest was skipped`));
  }

  static forMode(
    mode: Mode,
    cfg: ConnectorConfig,
    tokens: TokenStore,
    http: DeereHttpOptions = {},
  ): DeereClient {
    return new DeereClient({ endpoints: deereEndpoints(mode, cfg), tokens, http });
  }

  /**
   * Replay mode: the live client against `fixtures` (default: the committed Deere replay
   * fixtures, src/connectors/deere/replay.ts), with a fixed token and the job's clock driving
   * the time shift.
   */
  static forReplay(
    cfg: ConnectorConfig,
    http: DeereHttpOptions = {},
    fixtures?: readonly ReplayFixture[],
  ): DeereClient {
    return new DeereClient({
      endpoints: deereEndpoints('replay', cfg),
      tokens: new StaticTokenStore('deere', REPLAY_CREDENTIAL),
      http: { ...http, fetch: replayFetch('deere', { now: http.now, fixtures }) },
      autoConnect: false,
    });
  }

  private now(): Date {
    return (this.http.now ?? (() => new Date()))();
  }

  private readonly refresher: TokenRefresher = (rt) =>
    refreshDeereTokens(this.endpoints, rt, this.http);

  private async connect(): Promise<string> {
    if (this.endpoints.sim && this.autoConnect && !this.connectedThisPoll) {
      this.connectedThisPoll = true;
      return simAutoConnect(this.endpoints, this.tokens, this.http);
    }
    throw new OAuthReconnectError('deere', 'not connected');
  }

  private async token(): Promise<string> {
    try {
      return (await this.tokens.accessToken(this.refresher)) ?? (await this.connect());
    } catch (e) {
      if (e instanceof OAuthReconnectError) return this.connect();
      throw e;
    }
  }

  /**
   * The platform API URL below `apiBase`, each segment URI-encoded:
   * `apiUrl('organizations', orgId, 'farms')` → `<apiBase>/organizations/<orgId>/farms`.
   */
  apiUrl(...segments: string[]): string {
    return [this.endpoints.apiBase, ...segments.map(encodeURIComponent)].join('/');
  }

  /** GET one resource (public 1f seam): bearer token, one refresh-and-retry on 401, `schema`. */
  getOne<S extends ZodType>(
    schema: S,
    url: string,
    opts: DeereGetOptions = {},
  ): Promise<z.infer<S>> {
    return this.get(schema, url, opts);
  }

  /**
   * GET every item of a Deere collection (public 1f seam): the first request asks for
   * `opts.itemLimit` (default 100) unless the URL names one, then `nextPage` links are followed
   * (at most 50 pages); `schema` is a `deereCollectionSchema(item)` and validates every page.
   */
  getPaged<S extends ZodType<{ values: unknown[]; links: DeereLink[] }>>(
    schema: S,
    url: string,
    opts: DeereGetOptions = {},
  ): Promise<z.infer<S>['values']> {
    return this.all(schema, url, opts);
  }

  /** GET with the bearer token; one refresh-and-retry on 401. */
  private async get<S extends ZodType>(
    schema: S,
    url: string,
    opts: DeereGetOptions = {},
  ): Promise<z.infer<S>> {
    const accept = opts.accept ?? DEERE_MEDIA_TYPE;
    const call = (token: string) =>
      vendorJson(
        schema,
        url,
        { method: 'GET', headers: { authorization: `Bearer ${token}`, accept } },
        { ...this.http, vendor: 'deere' },
      );
    const token = await this.token();
    try {
      return await call(token);
    } catch (e) {
      if (!(e instanceof VendorHttpError) || e.status !== 401) throw e;
      let next: string | null;
      try {
        next = await this.tokens.refreshAfterReject(token, this.refresher);
      } catch (re) {
        if (!(re instanceof OAuthReconnectError)) throw re;
        next = await this.connect();
      }
      return call(next ?? (await this.connect()));
    }
  }

  /** Every item of a collection: the largest first page, then `nextPage` links. */
  private async all<T, S extends ZodType>(
    schema: S,
    firstUrl: string,
    opts: DeereGetOptions = {},
  ): Promise<T[]> {
    const out: T[] = [];
    const first = new URL(firstUrl);
    if (!first.searchParams.has('itemLimit')) {
      first.searchParams.set('itemLimit', String(opts.itemLimit ?? DEERE_PLATFORM_PAGE_LIMIT));
    }
    let url: string | undefined = first.toString();
    let page = 0;
    for (; url && page < MAX_PAGES; page++) {
      const body = (await this.get(schema, url, opts)) as CollectionOf<S> & { values: T[] };
      out.push(...body.values);
      const next = body.links.find((l) => l.rel === 'nextPage')?.uri;
      url = next ? new URL(next, url).toString() : undefined;
    }
    if (url) this.onTruncated(firstUrl, page);
    return out;
  }

  organizations(): Promise<DeereOrganization[]> {
    return this.all(deereOrganizationsSchema, `${this.endpoints.apiBase}/organizations`);
  }

  /**
   * The org's machines from the Equipment API (one org per call: Deere answers 403 for the whole
   * request if any listed org is not accessible). `capableOf: 'Connectivity'` = only machines
   * with a JDLink modem (the ones with breadcrumbs). Items carry `principalId` for the /platform
   * machine paths.
   */
  machines(orgId: string, opts: { capableOf?: 'Connectivity' } = {}): Promise<DeereEquipment[]> {
    const u = new URL(`${this.endpoints.equipmentBase}/equipment`);
    u.searchParams.set('organizationIds', orgId);
    u.searchParams.set('categories', 'Machine');
    if (opts.capableOf) u.searchParams.set('capableOf', opts.capableOf);
    return this.all(deereEquipmentListSchema, u.toString(), {
      accept: DEERE_EQUIPMENT_MEDIA_TYPE,
      itemLimit: DEERE_EQUIPMENT_PAGE_LIMIT,
    });
  }

  /** GET /machines/{principalId}/breadcrumbs (working-only positions; Deere's principalId, not the equipment id). */
  breadcrumbs(principalId: string, start: Date, end: Date): Promise<DeereBreadcrumb[]> {
    const u = new URL(
      `${this.endpoints.apiBase}/machines/${encodeURIComponent(principalId)}/breadcrumbs`,
    );
    u.searchParams.set('startDate', start.toISOString());
    u.searchParams.set('endDate', end.toISOString());
    return this.all(deereBreadcrumbsSchema, u.toString());
  }

  private orgUrl(orgId: string, ...rest: string[]): string {
    return [this.endpoints.apiBase, 'organizations', orgId, ...rest]
      .map((p, i) => (i === 0 ? p : encodeURIComponent(p)))
      .join('/');
  }

  /** GET /organizations/{orgId}/fields (every page). */
  fields(orgId: string): Promise<DeereField[]> {
    return this.all(deereFieldsSchema, this.orgUrl(orgId, 'fields'));
  }

  /** GET /organizations/{orgId}/boundaries: every boundary in the org (each links its field). */
  orgBoundaries(orgId: string): Promise<DeereBoundary[]> {
    return this.all(deereBoundariesSchema, this.orgUrl(orgId, 'boundaries'));
  }

  /** GET /organizations/{orgId}/fields/{fieldId}/boundaries. */
  fieldBoundaries(orgId: string, fieldId: string): Promise<DeereBoundary[]> {
    return this.all(deereBoundariesSchema, this.orgUrl(orgId, 'fields', fieldId, 'boundaries'));
  }

  /** GET /organizations/{orgId}/fields/{fieldId}/fieldOperations (optionally one crop season). */
  fieldOperations(
    orgId: string,
    fieldId: string,
    opts: { cropSeason?: string; fieldOperationType?: string } = {},
  ): Promise<DeereFieldOperation[]> {
    const u = new URL(this.orgUrl(orgId, 'fields', fieldId, 'fieldOperations'));
    if (opts.cropSeason) u.searchParams.set('cropSeason', opts.cropSeason);
    if (opts.fieldOperationType) u.searchParams.set('fieldOperationType', opts.fieldOperationType);
    return this.all(deereFieldOperationsSchema, u.toString());
  }

  /** GET /fieldOperations/{operationId}/measurementTypes: area worked, yield, moisture, rates. */
  fieldOperationMeasurements(operationId: string): Promise<DeereFieldOperationMeasurement[]> {
    return this.all(
      deereFieldOperationMeasurementsSchema,
      `${this.endpoints.apiBase}/fieldOperations/${encodeURIComponent(operationId)}/measurementTypes`,
    );
  }

  /**
   * GET /fieldOperations/{operationId}/boundary: the boundary Deere generates around the area the
   * operation worked (its coverage). Deere answers 400 when the field already has an active
   * boundary; 1f then reads the operation's shapefile instead. // doc-derived, confirm
   */
  fieldOperationCoverage(operationId: string): Promise<DeereBoundary> {
    return this.get(
      deereBoundarySchema,
      `${this.endpoints.apiBase}/fieldOperations/${encodeURIComponent(operationId)}/boundary`,
    );
  }

  /** GET /organizations/{orgId}/flags (every flag of the org; each links its field). */
  flags(orgId: string): Promise<DeereFlag[]> {
    return this.all(deereFlagsSchema, this.orgUrl(orgId, 'flags'));
  }

  /** GET /organizations/{orgId}/fields/{fieldId}/flags. */
  fieldFlags(orgId: string, fieldId: string): Promise<DeereFlag[]> {
    return this.all(deereFlagsSchema, this.orgUrl(orgId, 'fields', fieldId, 'flags'));
  }

  /** Breadcrumbs of every machine in every org for (cursor, now] (the sync step's `poll`). */
  async pollLocations(cursor: string | null): Promise<PollResult<RawItem<DeereBreadcrumbRaw>>> {
    this.connectedThisPoll = false;
    const end = this.now();
    const parsed = cursor ? Date.parse(cursor) : Number.NaN;
    const startMs = Number.isNaN(parsed)
      ? end.getTime() - this.firstLookbackMs
      : Math.max(parsed, end.getTime() - this.maxLookbackMs);
    const start = new Date(Math.min(startMs, end.getTime()));
    const items: RawItem<DeereBreadcrumbRaw>[] = [];
    const inWindow = (b: DeereBreadcrumb) => {
      const t = Date.parse(b.eventTimestamp);
      return t > start.getTime() && t <= end.getTime();
    };
    for (const org of await this.organizations()) {
      for (const m of await this.machines(org.id, { capableOf: 'Connectivity' })) {
        // The /platform machine paths and the ('deere', 'machine', …) refs use the principalId.
        const machineId = m.principalId;
        if (!machineId || m.archived) continue;
        const crumbs = (await this.breadcrumbs(machineId, start, end)).filter(inWindow);
        items.push(...deereBreadcrumbItems(org.id, machineId, crumbs));
      }
    }
    return { items, cursor: end.toISOString(), hasMore: false };
  }

  /** The contract port (contracts §8): normalized positions. */
  asPositionSource(): PositionSource {
    return {
      poll: async (cursor) => {
        const r = await this.pollLocations(cursor);
        return { ...r, items: r.items.flatMap((i) => mapDeereBreadcrumb(i.payload)) };
      },
    };
  }
}

/** Path of a URL for a log line (no query: ids and windows stay out of logs). */
function pathOfUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '(bad url)';
  }
}

/** A token store that always answers one fixed token (replay mode: no OAuth). */
export class StaticTokenStore implements TokenStore {
  readonly source: TokenStore['source'];
  private readonly token: string;
  constructor(source: TokenStore['source'], token: string) {
    this.source = source;
    this.token = token;
  }
  async accessToken(): Promise<string> {
    return this.token;
  }
  async refreshAfterReject(): Promise<string> {
    return this.token;
  }
  async save(): Promise<void> {}
}
