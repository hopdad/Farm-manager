/**
 * CNH FieldOps client, to CNH's published OpenAPI (SwaggerHub CNH/FieldOps-API 1.0.0; vendor-docs
 * cnh.md). Every API call carries `Authorization: Bearer <user token>` AND
 * `Ocp-Apim-Subscription-Key` (the app's key for the environment). The calls:
 *
 *   GET /companies, /UserProfile, /companies/{id}/overview                     (JSON)
 *   GET /companies/{id}/fields/{fieldId}/boundaries, /companies/{id}/boundaries/{boundaryId}
 *   GET /equipment (by VIN, no paging; answers without the EULA), /equipment/{vin}
 *   GET /equipment/{vin}/metrics?startDate&endDate&limit&cursor                (one-day windows)
 *   GET /Fleet/{page}, /Fleet/Equipment/{vin}                                  (ISO XML)
 *   GET /Fleet/Equipment/{vin}/{Series}/{startUTC}/{endUTC}/{page}             (ISO XML series:
 *       Locations, CautionCodes, Faults, …)
 *
 * Refusals, kept apart (none ever leaks a credential):
 *  - APIM's 401 with `WWW-Authenticate: AzureApiManagementKey` = the subscription key is missing,
 *    wrong, or of the other environment (staging vs production): `CnhSubscriptionKeyError`, never
 *    a token refresh;
 *  - any other 401 = the access token: refreshed once under the store's lock, then retried;
 *  - 403 "EULA not accepted for the VIN…" = that VIN only: `CnhEulaError` (the polls skip the VIN
 *    and list it as `needs_eula`, never the connection);
 *  - 429 with an integer Retry-After: honoured by the HTTP layer (a long wait becomes the
 *    stream's next run).
 * In sim mode a missing grant is created with the stand-in's unattended consent (once per poll);
 * in sandbox/live it fails with "sign in at /api/oauth/cnh". No replay mode (config refuses it).
 * CNH needs a staging recording before sandbox or live use (src/connectors/cnh/doc-derived.ts).
 */
import type { z } from 'zod';
import type { AempFleetPage } from '../aemp/parse';
import {
  AempParseError,
  aempBodyValue,
  nextPageNumber,
  parseCautionPage,
  parseFaultPage,
  parseFleetPage,
  parseLocationsPage,
} from '../aemp/parse';
import type { AempCaution, AempFaultCode, AempLocationItem } from '../aemp/schemas';
import { type CnhEndpoints, type ConnectorConfig, cnhEndpoints } from '../endpoints';
import { VendorHttpError, VendorResponseError, vendorFetch } from '../http';
import { OAuthReconnectError, type TokenStore } from '../oauth/token-store';
import type { Mode } from '../types';
import { type CnhHttpOptions, cnhSimAutoConnect, refreshCnhTokens } from './oauth';
import {
  CNH_EULA_MESSAGE,
  type CnhEquipment,
  cnhBoundarySchema,
  cnhCompaniesSchema,
  cnhEquipmentListSchema,
  cnhEquipmentSchema,
  cnhFieldBoundariesSchema,
  cnhMetricsSchema,
  cnhOverviewSchema,
  cnhUserProfileSchema,
} from './schemas';

/** Pages followed per snapshot or series window before giving up. */
export const CNH_MAX_PAGES = 50;

/** The subscription key was refused (missing, wrong, or of the other environment). */
export class CnhSubscriptionKeyError extends Error {
  constructor(environment: CnhEndpoints['environment']) {
    super(
      `cnh: CNH refused the subscription key (APIM 401, Ocp-Apim-Subscription-Key): set CNH_SUBSCRIPTION_KEY to this app's key for the ${environment} environment (staging and production keys differ)`,
    );
    this.name = 'CnhSubscriptionKeyError';
  }
}

/** No CNH grant: a person must sign in. */
export class CnhNotConnectedError extends Error {
  constructor(reason = 'not connected') {
    super(`cnh: ${reason}; sign in at /api/oauth/cnh`);
    this.name = 'CnhNotConnectedError';
  }
}

/** The VIN has no accepted EULA (telemetry refused; vehicle info still answers). */
export class CnhEulaError extends Error {
  readonly vin: string;
  constructor(vin: string, detail?: string) {
    super(`cnh: ${detail || CNH_EULA_MESSAGE} (${vin})`);
    this.name = 'CnhEulaError';
    this.vin = vin;
  }
}

const isApimKeyRefusal = (e: VendorHttpError) =>
  /AzureApiManagementKey/i.test(e.headers?.['www-authenticate'] ?? '');

const isEulaRefusal = (e: VendorHttpError) => e.status === 403 && /EULA/i.test(e.detail ?? '');

/** `2026-10-31T12:00:00Z`: the path form of a series window bound. */
export const cnhIsoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export interface CnhClientOptions {
  endpoints: CnhEndpoints;
  tokens: TokenStore;
  http?: CnhHttpOptions;
  /** Sim only: create the grant with the stand-in's unattended consent. Default true. */
  autoConnect?: boolean;
}

export class CnhClient {
  readonly endpoints: CnhEndpoints;
  private readonly tokens: TokenStore;
  private readonly http: CnhHttpOptions;
  private readonly autoConnect: boolean;
  private connected = false;

  constructor(opts: CnhClientOptions) {
    this.endpoints = opts.endpoints;
    this.tokens = opts.tokens;
    this.http = opts.http ?? {};
    this.autoConnect = opts.autoConnect ?? true;
  }

  static forMode(
    mode: Mode,
    cfg: ConnectorConfig,
    tokens: TokenStore,
    http: CnhHttpOptions = {},
  ): CnhClient {
    return new CnhClient({ endpoints: cnhEndpoints(mode, cfg), tokens, http });
  }

  private refresher = (rt: string) => refreshCnhTokens(this.endpoints, rt, this.http);

  private canAutoConnect(): boolean {
    return this.endpoints.environment === 'sim' && this.autoConnect && !this.connected;
  }

  private async simConnect(): Promise<string> {
    this.connected = true;
    return cnhSimAutoConnect(this.endpoints, this.tokens, this.http);
  }

  /** A usable access token (refreshing near expiry; sim: connecting once when missing). */
  private async accessToken(): Promise<string> {
    let token: string | null;
    try {
      token = await this.tokens.accessToken(this.refresher);
    } catch (e) {
      if (e instanceof OAuthReconnectError && this.canAutoConnect()) return this.simConnect();
      if (e instanceof OAuthReconnectError) throw new CnhNotConnectedError(e.message);
      throw e;
    }
    if (token) return token;
    if (this.canAutoConnect()) return this.simConnect();
    throw new CnhNotConnectedError();
  }

  /** One authenticated GET; the refusals of the file header. `vin` names a telemetry call. */
  private async get(url: string, accept: string, vin?: string): Promise<Response> {
    const send = (token: string) =>
      vendorFetch(
        url,
        {
          method: 'GET',
          headers: {
            authorization: `Bearer ${token}`,
            'ocp-apim-subscription-key': this.endpoints.subscriptionKey,
            accept,
          },
        },
        { ...this.http, vendor: 'cnh' },
      );
    const token = await this.accessToken();
    try {
      try {
        return await send(token);
      } catch (e) {
        if (!(e instanceof VendorHttpError) || e.status !== 401 || isApimKeyRefusal(e)) throw e;
        let next: string | null;
        try {
          next = await this.tokens.refreshAfterReject(token, this.refresher);
        } catch (r) {
          if (r instanceof OAuthReconnectError && this.canAutoConnect()) {
            next = await this.simConnect();
          } else if (r instanceof OAuthReconnectError) {
            throw new CnhNotConnectedError(r.message);
          } else {
            throw r;
          }
        }
        if (!next) throw new CnhNotConnectedError();
        return await send(next);
      }
    } catch (e) {
      if (e instanceof VendorHttpError && e.status === 401 && isApimKeyRefusal(e)) {
        throw new CnhSubscriptionKeyError(this.endpoints.environment);
      }
      if (e instanceof VendorHttpError && vin && isEulaRefusal(e)) {
        throw new CnhEulaError(vin, e.detail);
      }
      throw e;
    }
  }

  private url(path: string, query: Record<string, string | undefined> = {}): string {
    const u = new URL(`${this.endpoints.apiBase}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  }

  private async json<S extends z.ZodType>(
    schema: S,
    path: string,
    query = {},
  ): Promise<z.infer<S>> {
    const url = this.url(path, query);
    const res = await this.get(url, 'application/json');
    const text = await res.text();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new VendorResponseError('cnh', new URL(url).pathname, 'body is not JSON');
    }
    const r = schema.safeParse(value);
    if (!r.success) {
      const i = r.error.issues[0];
      throw new VendorResponseError(
        'cnh',
        new URL(url).pathname,
        i ? `${i.path.join('.') || '(root)'}: ${i.message}` : 'schema mismatch',
      );
    }
    return r.data;
  }

  /** An ISO-style telemetry body (XML documented; JSON read too), keys in ISO spelling. */
  private async iso<T>(
    path: string,
    read: (v: unknown) => T,
    vin?: string,
    query = {},
  ): Promise<T> {
    const url = this.url(path, query);
    // doc-derived, confirm: CNH documents only application/xml for these 200s.
    const res = await this.get(url, 'application/xml, application/json;q=0.9', vin);
    try {
      return read(aempBodyValue(await res.text(), res.headers.get('content-type'), 'auto'));
    } catch (e) {
      if (e instanceof AempParseError) {
        throw new VendorResponseError('cnh', new URL(url).pathname, e.message);
      }
      throw e;
    }
  }

  // ---- farm setup ----------------------------------------------------------------------------

  /** GET /companies: the companies the signed-in user reaches (`id` = the source_org). */
  async companies(): Promise<{ id: string; name: string | null }[]> {
    const r = await this.json(cnhCompaniesSchema, '/companies');
    return r.companies.map((c) => ({ id: c.id, name: c.name ?? c.companyName ?? null }));
  }

  /** GET /UserProfile */
  userProfile() {
    return this.json(cnhUserProfileSchema, '/UserProfile');
  }

  /** GET /companies/{companyId}/overview (growers → farms → fields, names only). */
  overview(companyId: string) {
    return this.json(cnhOverviewSchema, `/companies/${encodeURIComponent(companyId)}/overview`);
  }

  /** GET /companies/{companyId}/fields/{fieldId}/boundaries (records, no geometry). */
  fieldBoundaries(companyId: string, fieldId: string) {
    return this.json(
      cnhFieldBoundariesSchema,
      `/companies/${encodeURIComponent(companyId)}/fields/${encodeURIComponent(fieldId)}/boundaries`,
    );
  }

  /** GET /companies/{companyId}/boundaries/{boundaryId} (one record WITH its geometry). */
  boundary(companyId: string, boundaryId: string) {
    return this.json(
      cnhBoundarySchema,
      `/companies/${encodeURIComponent(companyId)}/boundaries/${encodeURIComponent(boundaryId)}`,
    );
  }

  // ---- equipment ---------------------------------------------------------------------------

  /** GET /equipment: every machine of the user's companies (bad items dropped, with a VIN only). */
  async equipment(): Promise<{ items: (CnhEquipment & { vin: string })[]; dropped: number }> {
    const r = await this.json(cnhEquipmentListSchema, '/equipment');
    const items: (CnhEquipment & { vin: string })[] = [];
    let dropped = 0;
    for (const raw of r.equipment) {
      const e = cnhEquipmentSchema.safeParse(raw);
      if (e.success && e.data.vin) items.push({ ...e.data, vin: e.data.vin });
      else dropped++;
    }
    return { items, dropped };
  }

  /** GET /equipment/{vin} (devices with their modem subscriptions). */
  equipmentDetail(vin: string) {
    return this.json(cnhEquipmentSchema, `/equipment/${encodeURIComponent(vin)}`);
  }

  /** GET /equipment/{vin}/metrics, one page (CNH: keep the window to one day). */
  metrics(
    vin: string,
    startMs: number,
    endMs: number,
    page: { cursor?: string; limit?: number } = {},
  ) {
    return this.json(cnhMetricsSchema, `/equipment/${encodeURIComponent(vin)}/metrics`, {
      startDate: cnhIsoSeconds(startMs),
      endDate: cnhIsoSeconds(endMs),
      limit: page.limit === undefined ? undefined : String(page.limit),
      cursor: page.cursor,
    });
  }

  // ---- ISO-style telemetry -------------------------------------------------------------------

  /** GET /Fleet/{page} (the snapshot; "a delay of up to one hour"). */
  fleetPage(page: number): Promise<AempFleetPage> {
    return this.iso(`/Fleet/${page}`, (v) => parseFleetPage(v, 'VIN'), undefined, {
      profile: 'CP',
    });
  }

  /** GET /Fleet/Equipment/{vin}: one machine's snapshot (a 403 for a VIN without the EULA). */
  fleetEquipment(vin: string): Promise<AempFleetPage> {
    return this.iso(
      `/Fleet/Equipment/${encodeURIComponent(vin)}`,
      (v) => parseFleetPage(v, 'VIN'),
      vin,
      { profile: 'CP' },
    );
  }

  /** Every page of the snapshot (page URLs rebuilt from apiBase, never an href's host). */
  async fleetSnapshot(): Promise<AempFleetPage> {
    const all: AempFleetPage = {
      version: null,
      snapshotTime: null,
      links: [],
      machines: [],
      dropped: [],
    };
    let page = 1;
    for (let n = 0; n < CNH_MAX_PAGES; n++) {
      const p = await this.fleetPage(page);
      all.version ??= p.version;
      all.snapshotTime ??= p.snapshotTime;
      all.machines.push(...p.machines);
      all.dropped.push(...p.dropped);
      if (!p.links.some((l) => l.rel === 'next')) break;
      const next = nextPageNumber(p.links) ?? page + 1;
      if (next <= page) break;
      page = next;
    }
    return all;
  }

  private async series<T>(
    vin: string,
    name: string,
    startMs: number,
    endMs: number,
    read: (v: unknown) => { links: { rel: string; href: string }[]; items: T[] },
    query: Record<string, string> = {},
  ): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    for (let n = 0; n < CNH_MAX_PAGES; n++) {
      const path = `/Fleet/Equipment/${encodeURIComponent(vin)}/${name}/${cnhIsoSeconds(startMs)}/${cnhIsoSeconds(endMs)}/${page}`;
      const r = await this.iso(path, read, vin, query);
      out.push(...r.items);
      if (!r.links.some((l) => l.rel === 'next')) break;
      const next = nextPageNumber(r.links) ?? page + 1;
      if (next <= page) break;
      page = next;
    }
    return out;
  }

  /** The Locations series (the trail) of one VIN in [start, end]. */
  locations(vin: string, startMs: number, endMs: number): Promise<AempLocationItem[]> {
    return this.series(vin, 'Locations', startMs, endMs, parseLocationsPage, { profile: 'CP' });
  }

  /** The CautionCodes series (OEM caution codes with `Active`); `verbose=true` for CNH's extras. */
  cautionCodes(vin: string, startMs: number, endMs: number): Promise<AempCaution[]> {
    return this.series(vin, 'CautionCodes', startMs, endMs, parseCautionPage, { verbose: 'true' });
  }

  /** The Faults series (DTC occurrences, no state). */
  faultCodes(vin: string, startMs: number, endMs: number): Promise<AempFaultCode[]> {
    return this.series(vin, 'Faults', startMs, endMs, parseFaultPage);
  }
}
