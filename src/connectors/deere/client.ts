/**
 * Deere live client (sim mode = this client against `${VENDOR_SIM_URL}/deere`).
 *
 * Every call carries a bearer token from the OAuth token store; a 401 refreshes once under the
 * advisory lock (another caller may already have) and retries. Collections follow `nextPage`
 * links. In sim mode, a missing grant is created with the stand-in's unattended consent
 * (`simAutoConnect`), at most once per poll, so `pnpm dev` runs with no clicks; in sandbox/live
 * a missing grant fails the step with "sign in at /api/oauth/deere".
 *
 * Locations: orgs → machines per org → breadcrumbs per machine for (cursor, now]. The cursor is
 * the ISO end of the last window (wall clock). A first run looks back `firstLookbackMs`.
 */
import type { ZodType, z } from 'zod';
import { type ConnectorConfig, type DeereEndpoints, deereEndpoints } from '../endpoints';
import { VendorHttpError, vendorJson } from '../http';
import { OAuthReconnectError, type TokenRefresher, type TokenStore } from '../oauth/token-store';
import type { Mode, PollResult, PositionSource, RawItem } from '../types';
import { deereBreadcrumbItems, mapDeereBreadcrumb } from './mapper';
import { type DeereHttpOptions, refreshDeereTokens, simAutoConnect } from './oauth';
import {
  DEERE_MEDIA_TYPE,
  type DeereBreadcrumb,
  type DeereBreadcrumbRaw,
  type DeereLink,
  type DeereMachine,
  type DeereOrganization,
  deereBreadcrumbsSchema,
  deereMachinesSchema,
  deereOrganizationsSchema,
} from './schemas';

/** Pages followed per collection before giving up (a runaway `nextPage` loop). */
const MAX_PAGES = 50;

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
}

type CollectionOf<T extends ZodType> = z.infer<T> & { links: DeereLink[] };

export class DeereClient {
  readonly endpoints: DeereEndpoints;
  private readonly tokens: TokenStore;
  private readonly http: DeereHttpOptions;
  private readonly autoConnect: boolean;
  private readonly firstLookbackMs: number;
  private readonly maxLookbackMs: number;
  private connectedThisPoll = false;

  constructor(opts: DeereClientOptions) {
    this.endpoints = opts.endpoints;
    this.tokens = opts.tokens;
    this.http = opts.http ?? {};
    this.autoConnect = opts.autoConnect ?? true;
    this.firstLookbackMs = opts.firstLookbackMs ?? 10 * 60_000;
    this.maxLookbackMs = opts.maxLookbackMs ?? 60 * 60_000;
  }

  static forMode(
    mode: Mode,
    cfg: ConnectorConfig,
    tokens: TokenStore,
    http: DeereHttpOptions = {},
  ): DeereClient {
    return new DeereClient({ endpoints: deereEndpoints(mode, cfg), tokens, http });
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

  /** GET with the bearer token; one refresh-and-retry on 401. */
  private async get<S extends ZodType>(schema: S, url: string): Promise<z.infer<S>> {
    const call = (token: string) =>
      vendorJson(
        schema,
        url,
        { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: DEERE_MEDIA_TYPE } },
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

  /** Every item of a collection, following `nextPage` links. */
  private async all<T, S extends ZodType>(schema: S, firstUrl: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | undefined = firstUrl;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const body = (await this.get(schema, url)) as CollectionOf<S> & { values: T[] };
      out.push(...body.values);
      url = body.links.find((l) => l.rel === 'nextPage')?.uri;
    }
    return out;
  }

  organizations(): Promise<DeereOrganization[]> {
    return this.all(deereOrganizationsSchema, `${this.endpoints.apiBase}/organizations`);
  }

  machines(orgId: string): Promise<DeereMachine[]> {
    return this.all(
      deereMachinesSchema,
      `${this.endpoints.apiBase}/organizations/${encodeURIComponent(orgId)}/machines`,
    );
  }

  breadcrumbs(machineId: string, start: Date, end: Date): Promise<DeereBreadcrumb[]> {
    const u = new URL(
      `${this.endpoints.apiBase}/machines/${encodeURIComponent(machineId)}/breadcrumbs`,
    );
    u.searchParams.set('startDate', start.toISOString());
    u.searchParams.set('endDate', end.toISOString());
    return this.all(deereBreadcrumbsSchema, u.toString());
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
    for (const org of await this.organizations()) {
      for (const m of await this.machines(org.id)) {
        items.push(...deereBreadcrumbItems(org.id, m.id, await this.breadcrumbs(m.id, start, end)));
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
