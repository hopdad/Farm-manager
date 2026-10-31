/**
 * Motive client (slice 1f.2, the trucks builder; docs/contracts-1f.md part B, §B.1): the
 * vehicle telematics port over Motive's REST API, in every mode (sim = the stand-in, replay =
 * the doc-derived fixtures, sandbox = a TEST MODE key, live). Frozen exports (§5.0):
 * `MotiveClient.forMode`, `pollPositions` (raw items with `externalId`) and `mapMotivePosition`
 * (tools/vendor-sim/connect.ts and src/connectors/mappers.test.ts use them).
 *
 * Every call sends `X-Api-Key` and `X-Metric-Units: false` (imperial: mph, miles, gallons;
 * Motive's default is ambiguous). The SNAPSHOT-DIFF sync model (src/connectors/sync-models.ts):
 * Motive answers only "the current state", so each stream's cursor remembers a version per key
 * and a poll returns what moved:
 *
 *   positions  v3 /vehicle_locations (Motive Vehicle Gateway units: `kph`, `vehicle_state`)
 *              for the vehicles it lists, v2 (`speed` in mph) for every other vehicle;
 *              `newer` by `located_at` per vehicle
 *   stats      v2 /vehicle_locations current_location (true_engine_hours, true_odometer, fuel %;
 *              v3 has none); `changed` on the stat values per vehicle
 *   faults     /v1/fault_codes (status open/closed, first/last observed; top-level paging) over
 *              the last 7 days; `changed` on status + last_observed_at per fault id
 *   vehicles   /v1/vehicles + /v1/groups (group names are the kind tags); `changed` per vehicle
 *
 * `sourceOrg` = the company id from GET /v1/companies (cached an hour), so two haulers' vehicle
 * ids never collide. Items the lenient schemas can't read are dropped and logged with their id,
 * never the page (§B.5); vehicles the farm doesn't map can be left out before landing (`only`).
 * A 429's "Retry after N seconds" message becomes `retryAfterSeconds` (Motive documents no
 * Retry-After header). Positions and stats share one v2 read per run (`snapshotTtlMs`).
 */

import type { z } from 'zod';
import {
  type ConnectorConfig,
  type MotiveEndpoint,
  motiveEndpoint,
  replayFetch,
} from '../endpoints';
import { VendorHttpError, type VendorHttpOptions, vendorJson } from '../http';
import { fingerprint, pollSnapshotDiff } from '../sync-models';
import type {
  Mode,
  NormalizedVehicle,
  PollResult,
  PositionSource,
  RawItem,
  VehicleTelematicsSource,
} from '../types';
import { mapMotiveFault, mapMotivePosition, mapMotiveStat, mapMotiveVehicle } from './mapper';
import {
  type MotiveFaultCode,
  type MotiveFaultRaw,
  type MotivePositionRaw,
  type MotiveStatRaw,
  type MotiveVehicle,
  type MotiveVehicleListItem,
  type MotiveVehicleRaw,
  motiveCompaniesSchema,
  motiveFaultCodeItemSchema,
  motiveFaultCodesPageSchema,
  motiveGroupsSchema,
  motiveVehicleListItemSchema,
  motiveVehicleLocationItemSchema,
  motiveVehicleLocationsPageSchema,
} from './schemas';

export { mapMotivePosition } from './mapper';

/** Motive's page size maximum (its Pagination page). */
export const MOTIVE_PER_PAGE = 100;
/** Most pages one list read follows (100 per page: 2 000 vehicles). */
export const MOTIVE_MAX_PAGES = 20;
/** /v1/fault_codes window: Motive's own default (`start_date` = today − 7 days). */
export const MOTIVE_FAULT_WINDOW_DAYS = 7;
/** How long a company id is reused before GET /v1/companies is asked again. */
export const MOTIVE_COMPANY_TTL_MS = 3_600_000;

export type MotiveLog = (msg: string, data?: Record<string, unknown>) => void;

export interface MotiveClientOptions {
  /** Keep only these Motive vehicle ids (the ones the farm maps); null/undefined = all. */
  only?: ReadonlySet<string> | null;
  /** Dropped items and fallbacks (no secrets). */
  log?: MotiveLog;
  /** A v2 read younger than this is reused by the next stream of the run (default 5 000 ms). */
  snapshotTtlMs?: number;
}

const companies = new Map<string, { id: string; at: number }>();

/** "Rate limit exceeded, Retry after 7 seconds" → 7 (Motive's documented 429 bodies). */
export function motiveRetryAfter(detail: string | undefined): number | undefined {
  const m = /retry\s+after\s+(\d+(?:\.\d+)?)\s*s/i.exec(detail ?? '');
  return m ? Math.ceil(Number(m[1])) : undefined;
}

/** YYYY-MM-DD (UTC) of an instant: Motive's `date` parameters. */
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

type Paged = Record<string, unknown> & {
  pagination?: { per_page: number; page_no: number; total: number };
  per_page?: number;
  page_no?: number;
  total?: number;
};

interface ItemSchema<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false };
}

export class MotiveClient {
  readonly endpoint: MotiveEndpoint;
  private readonly http: Omit<VendorHttpOptions, 'vendor'>;
  private readonly opts: MotiveClientOptions;
  private v2: { at: number; vehicles: MotiveVehicle[] } | null = null;

  constructor(
    endpoint: MotiveEndpoint,
    http: Omit<VendorHttpOptions, 'vendor'> = {},
    opts: MotiveClientOptions = {},
  ) {
    this.endpoint = endpoint;
    this.http = http;
    this.opts = opts;
  }

  static forMode(
    mode: Mode,
    cfg: ConnectorConfig,
    http: Omit<VendorHttpOptions, 'vendor'> = {},
    opts: MotiveClientOptions = {},
  ): MotiveClient {
    if (mode === 'replay') {
      return new MotiveClient(
        motiveEndpoint(mode, cfg),
        { ...http, fetch: replayFetch('motive', { now: http.now }) },
        opts,
      );
    }
    return new MotiveClient(motiveEndpoint(mode, cfg), http, opts);
  }

  private now(): number {
    return (this.http.now?.() ?? new Date()).getTime();
  }

  private log(msg: string, data?: Record<string, unknown>) {
    this.opts.log?.(msg, data);
  }

  private keep(vehicleId: string | undefined): vehicleId is string {
    return !!vehicleId && (!this.opts.only || this.opts.only.has(vehicleId));
  }

  /** GET one Motive path (the key rides in a header, never in the query). */
  private async get<T>(
    schema: z.ZodType,
    path: string,
    query: Record<string, string> = {},
  ): Promise<T> {
    const u = new URL(`${this.endpoint.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    try {
      return (await vendorJson(
        schema,
        u.toString(),
        {
          method: 'GET',
          headers: {
            'x-api-key': this.endpoint.apiKey,
            'x-metric-units': 'false',
            accept: 'application/json',
          },
        },
        { ...this.http, vendor: 'motive' },
      )) as T;
    } catch (e) {
      // Motive documents no Retry-After header; its 429 bodies say "Retry after N seconds".
      if (e instanceof VendorHttpError && e.status === 429 && e.retryAfterSeconds === undefined) {
        const s = motiveRetryAfter(e.detail);
        if (s !== undefined) {
          throw new VendorHttpError({
            vendor: e.vendor,
            status: e.status,
            path: e.path,
            retryAfterSeconds: s,
            detail: e.detail,
            headers: e.headers,
          });
        }
      }
      throw e;
    }
  }

  /**
   * Every page of a Motive list: `per_page` ≤ 100, stop when page_no × per_page ≥ total (the
   * `pagination` object, or the top-level fields of /v1/fault_codes), on an empty or short
   * page, or at MOTIVE_MAX_PAGES. Items are parsed one by one: a bad item is dropped, logged.
   */
  private async list<T>(
    path: string,
    key: 'vehicles' | 'fault_codes',
    item: ItemSchema<T>,
    query: Record<string, string> = {},
  ): Promise<T[]> {
    const pageSchema =
      key === 'fault_codes' ? motiveFaultCodesPageSchema : motiveVehicleLocationsPageSchema;
    const out: T[] = [];
    for (let page = 1; page <= MOTIVE_MAX_PAGES; page++) {
      const body = await this.get<Paged>(pageSchema, path, {
        ...query,
        per_page: String(MOTIVE_PER_PAGE),
        page_no: String(page),
      });
      const items = (body[key] as unknown[] | undefined) ?? [];
      for (const raw of items) {
        const r = item.safeParse(raw);
        if (r.success) out.push(r.data);
        else this.log('motive: unreadable item dropped', { path, id: idOf(raw) });
      }
      const p =
        body.pagination ??
        (body.per_page !== undefined && body.page_no !== undefined && body.total !== undefined
          ? { per_page: body.per_page, page_no: body.page_no, total: body.total }
          : null);
      if (items.length === 0) break;
      if (p ? p.page_no * p.per_page >= p.total : items.length < MOTIVE_PER_PAGE) break;
    }
    return out;
  }

  /** The company id (GET /v1/companies; cached MOTIVE_COMPANY_TTL_MS per host and key). */
  async companyId(): Promise<string> {
    const key = `${this.endpoint.baseUrl}|${fingerprint(this.endpoint.apiKey)}`;
    const hit = companies.get(key);
    if (hit && this.now() - hit.at < MOTIVE_COMPANY_TTL_MS) return hit.id;
    const body = await this.get<{ companies: { company: { id: string } }[] }>(
      motiveCompaniesSchema,
      '/v1/companies',
    );
    const id = body.companies[0]?.company.id ?? '';
    if (!id) this.log('motive: GET /v1/companies listed no company; vehicles keyed without one');
    companies.set(key, { id, at: this.now() });
    return id;
  }

  /** Every vehicle of a vehicle_locations list (v1/v2: all vehicles; v3: gateway units only). */
  async vehicleLocations(api: 'v1' | 'v2' | 'v3'): Promise<MotiveVehicle[]> {
    const items = await this.list(
      `/${api}/vehicle_locations`,
      'vehicles',
      motiveVehicleLocationItemSchema as ItemSchema<{ vehicle: MotiveVehicle }>,
    );
    return items.map((i) => i.vehicle);
  }

  /** v3, or null when this key may not read it (403/404: then v2 serves every vehicle). */
  private async gatewayLocations(): Promise<MotiveVehicle[] | null> {
    try {
      return await this.vehicleLocations('v3');
    } catch (e) {
      if (e instanceof VendorHttpError && (e.status === 403 || e.status === 404)) {
        this.log('motive: v3 vehicle_locations refused; reading every vehicle from v2', {
          status: e.status,
        });
        return null;
      }
      throw e;
    }
  }

  /** The v2 list, reused for `snapshotTtlMs` (positions and stats in one run read it once). */
  private async v2Vehicles(fresh: boolean): Promise<MotiveVehicle[]> {
    const ttl = this.opts.snapshotTtlMs ?? 5_000;
    if (!fresh && this.v2 && this.now() - this.v2.at < ttl) return this.v2.vehicles;
    const vehicles = await this.vehicleLocations('v2');
    this.v2 = { at: this.now(), vehicles };
    return vehicles;
  }

  /** Stream 'positions': each vehicle's newest location (v3 for gateway units, else v2). */
  async pollPositions(cursor: string | null): Promise<PollResult<RawItem<MotivePositionRaw>>> {
    const companyId = await this.companyId();
    const gateway = await this.gatewayLocations();
    const all = await this.v2Vehicles(true);
    const viaV3 = new Set((gateway ?? []).map((v) => v.id));
    const items: RawItem<MotivePositionRaw>[] = [];
    const add = (v: MotiveVehicle, api: 'v2' | 'v3') => {
      const loc = v.current_location;
      if (!loc || !this.keep(v.id)) return;
      const t = new Date(loc.located_at).toISOString();
      items.push({
        externalId: `${v.id}:${t}`,
        payload: { id: v.id, number: v.number ?? null, companyId, api, location: loc },
      });
    };
    for (const v of gateway ?? []) add(v, 'v3');
    for (const v of all) if (!viaV3.has(v.id)) add(v, 'v2');
    const r = await pollSnapshotDiff({
      cursor,
      fetchSnapshot: async () => items,
      keyOf: (i) => i.payload.id,
      versionOf: (i) => Date.parse(i.payload.location.located_at),
      mode: 'newer',
    });
    return { items: r.items, cursor: r.cursor, hasMore: false };
  }

  /** Stream 'stats': engine hours, odometer and fuel from v2's current_location, when they change. */
  async pollStats(cursor: string | null): Promise<PollResult<RawItem<MotiveStatRaw>>> {
    const companyId = await this.companyId();
    const all = await this.v2Vehicles(false);
    const items: RawItem<MotiveStatRaw>[] = [];
    for (const v of all) {
      const l = v.current_location;
      if (!l || !this.keep(v.id)) continue;
      if (statValues(l).every((s) => s === null)) continue;
      const t = new Date(l.located_at).toISOString();
      items.push({
        externalId: `${v.id}:stats:${t}`,
        payload: { id: v.id, number: v.number ?? null, companyId, location: l },
      });
    }
    const r = await pollSnapshotDiff({
      cursor,
      fetchSnapshot: async () => items,
      keyOf: (i) => i.payload.id,
      versionOf: (i) => JSON.stringify(statValues(i.payload.location)),
      mode: 'changed',
    });
    return { items: r.items, cursor: r.cursor, hasMore: false };
  }

  /** Every fault record of the last MOTIVE_FAULT_WINDOW_DAYS (/v1/fault_codes). */
  async faultCodes(): Promise<MotiveFaultCode[]> {
    const now = this.now();
    // doc-derived, confirm: whether start_date/end_date filter on the first or the last
    // observation, and whether an open fault older than the window is still listed
    // (https://developer-docs.gomotive.com/reference/fetch-a-list-of-all-the-vehicles-fault-codes)
    const items = await this.list(
      '/v1/fault_codes',
      'fault_codes',
      motiveFaultCodeItemSchema as ItemSchema<{ fault_code: MotiveFaultCode }>,
      {
        start_date: utcDate(now - MOTIVE_FAULT_WINDOW_DAYS * 86_400_000),
        end_date: utcDate(now),
      },
    );
    return items.map((i) => i.fault_code);
  }

  /** Stream 'faults': fault records whose status or last observation moved (delta reports). */
  async pollFaults(cursor: string | null): Promise<PollResult<RawItem<MotiveFaultRaw>>> {
    const companyId = await this.companyId();
    const items: RawItem<MotiveFaultRaw>[] = [];
    for (const f of await this.faultCodes()) {
      const vehicleId = f.vehicle?.id;
      if (!this.keep(vehicleId)) continue;
      const seen = f.last_observed_at ?? f.first_observed_at;
      const at = seen ? new Date(seen).toISOString() : '';
      items.push({
        externalId: `${vehicleId}:fault:${f.id}:${f.status}:${at}`,
        payload: { companyId, fault: f },
      });
    }
    const r = await pollSnapshotDiff({
      cursor,
      fetchSnapshot: async () => items,
      keyOf: (i) => i.payload.fault.id,
      versionOf: (i) =>
        `${i.payload.fault.status}|${i.payload.fault.last_observed_at ?? i.payload.fault.first_observed_at ?? ''}`,
      mode: 'changed',
    });
    return { items: r.items, cursor: r.cursor, hasMore: false };
  }

  /** Group id → name (GET /v1/groups). */
  async groups(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let page = 1; page <= MOTIVE_MAX_PAGES; page++) {
      const body = await this.get<{
        groups: { group: { id: string; name?: string | null } }[];
        pagination?: { per_page: number; page_no: number; total: number };
      }>(motiveGroupsSchema, '/v1/groups', {
        per_page: String(MOTIVE_PER_PAGE),
        page_no: String(page),
      });
      for (const { group } of body.groups) if (group.name) out.set(group.id, group.name);
      const p = body.pagination;
      if (body.groups.length === 0) break;
      if (p ? p.page_no * p.per_page >= p.total : body.groups.length < MOTIVE_PER_PAGE) break;
    }
    return out;
  }

  /** Every vehicle of GET /v1/vehicles with its group names. */
  async vehicleList(): Promise<{ vehicle: MotiveVehicleListItem['vehicle']; groups: string[] }[]> {
    const vehicles = await this.list(
      '/v1/vehicles',
      'vehicles',
      motiveVehicleListItemSchema as ItemSchema<MotiveVehicleListItem>,
    );
    const needGroups = vehicles.some((v) => (v.vehicle.group_ids ?? []).length > 0);
    const names = needGroups ? await this.groups() : new Map<string, string>();
    return vehicles.map(({ vehicle }) => ({
      vehicle,
      groups: (vehicle.group_ids ?? []).flatMap((g) => {
        const n = names.get(g);
        return n ? [n] : [];
      }),
    }));
  }

  /** Stream 'vehicles': each vehicle whose name, groups, make, model, year or VIN changed. */
  async pollVehicles(cursor: string | null): Promise<PollResult<RawItem<MotiveVehicleRaw>>> {
    const companyId = await this.companyId();
    const items: RawItem<MotiveVehicleRaw>[] = [];
    for (const { vehicle, groups } of await this.vehicleList()) {
      if (!this.keep(vehicle.id)) continue;
      const payload: MotiveVehicleRaw = { companyId, vehicle, groups: [...groups].sort() };
      items.push({ externalId: `${vehicle.id}:vehicle:${vehicleVersion(payload)}`, payload });
    }
    const r = await pollSnapshotDiff({
      cursor,
      fetchSnapshot: async () => items,
      keyOf: (i) => i.payload.vehicle.id,
      versionOf: (i) => vehicleVersion(i.payload),
      mode: 'changed',
    });
    return { items: r.items, cursor: r.cursor, hasMore: false };
  }

  /** The port (src/connectors/types.ts VehicleTelematicsSource), mapped. */
  asTelematicsSource(
    opts: { kindTags?: Parameters<typeof mapMotiveVehicle>[1] } = {},
  ): Required<VehicleTelematicsSource> {
    return {
      positions: async (cursor) => {
        const r = await this.pollPositions(cursor);
        return { ...r, items: r.items.flatMap((i) => mapMotivePosition(i.payload)) };
      },
      stats: async (cursor) => {
        const r = await this.pollStats(cursor);
        return { ...r, items: r.items.flatMap((i) => mapMotiveStat(i.payload)) };
      },
      faults: async (cursor) => {
        const r = await this.pollFaults(cursor);
        return { ...r, items: r.items.flatMap((i) => mapMotiveFault(i.payload)) };
      },
      vehicles: async (): Promise<NormalizedVehicle[]> => {
        const companyId = await this.companyId();
        return (await this.vehicleList()).flatMap(({ vehicle, groups }) =>
          mapMotiveVehicle({ companyId, vehicle, groups }, opts.kindTags),
        );
      },
    };
  }

  asPositionSource(): PositionSource {
    return { poll: (cursor) => this.asTelematicsSource().positions(cursor) };
  }
}

/** The stat values of a current_location (null when absent), in a fixed order. */
function statValues(l: MotiveVehicle['current_location'] & object): (number | null)[] {
  return [
    l.true_engine_hours ?? null,
    l.engine_hours ?? null,
    l.true_odometer ?? null,
    l.odometer ?? null,
    l.fuel_primary_remaining_percentage ?? null,
  ];
}

function vehicleVersion(p: MotiveVehicleRaw): string {
  const v = p.vehicle;
  return fingerprint(
    JSON.stringify([
      v.number ?? null,
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
  const o = raw as { vehicle?: { id?: unknown }; fault_code?: { id?: unknown } } | null;
  const id = o?.vehicle?.id ?? o?.fault_code?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}
