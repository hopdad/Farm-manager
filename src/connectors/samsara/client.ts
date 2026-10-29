/**
 * Samsara live client (sim mode = this client against `${VENDOR_SIM_URL}/samsara`).
 *
 * Cursor feeds: the first call (no cursor) returns the latest event per vehicle plus an
 * endCursor; later calls pass it as `after` and get only newer events; `hasNextPage` says more
 * are ready right now (runSyncStep keeps polling while it is true, within the job budget).
 * The stored cursor is the endCursor string; an empty endCursor keeps the previous one.
 */
import { type ConnectorConfig, type SamsaraEndpoint, samsaraEndpoint } from '../endpoints';
import { type VendorHttpOptions, vendorJson } from '../http';
import type { Mode, PollResult, PositionSource, RawItem, VehicleStatsSource } from '../types';
import {
  mapSamsaraPosition,
  mapSamsaraStat,
  samsaraPositionItems,
  samsaraStatItems,
} from './mapper';
import {
  SAMSARA_STAT_TYPES,
  type SamsaraLocationsFeed,
  type SamsaraPositionRaw,
  type SamsaraStatRaw,
  type SamsaraStatsFeed,
  samsaraLocationsFeedSchema,
  samsaraStatsFeedSchema,
} from './schemas';

export type SamsaraHttpOptions = Omit<VendorHttpOptions, 'vendor'>;

export class SamsaraClient {
  readonly endpoint: SamsaraEndpoint;
  private readonly http: SamsaraHttpOptions;

  constructor(endpoint: SamsaraEndpoint, http: SamsaraHttpOptions = {}) {
    this.endpoint = endpoint;
    this.http = http;
  }

  static forMode(mode: Mode, cfg: ConnectorConfig, http: SamsaraHttpOptions = {}): SamsaraClient {
    return new SamsaraClient(samsaraEndpoint(mode, cfg), http);
  }

  private get<T>(
    schema: typeof samsaraLocationsFeedSchema | typeof samsaraStatsFeedSchema,
    path: string,
    params: Record<string, string | null>,
  ): Promise<T> {
    const url = new URL(`${this.endpoint.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    return vendorJson(
      schema,
      url.toString(),
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.endpoint.apiToken}`,
          accept: 'application/json',
        },
      },
      { ...this.http, vendor: 'samsara' },
    ) as Promise<T>;
  }

  /** GET /fleet/vehicles/locations/feed */
  locationsFeed(after: string | null, vehicleIds?: string[]): Promise<SamsaraLocationsFeed> {
    return this.get(samsaraLocationsFeedSchema, '/fleet/vehicles/locations/feed', {
      after,
      vehicleIds: vehicleIds?.length ? vehicleIds.join(',') : null,
    });
  }

  /** GET /fleet/vehicles/stats/feed (engine hours, fuel, odometer). */
  statsFeed(after: string | null): Promise<SamsaraStatsFeed> {
    return this.get(samsaraStatsFeedSchema, '/fleet/vehicles/stats/feed', {
      after,
      types: SAMSARA_STAT_TYPES.join(','),
    });
  }

  /** One page of the locations feed as raw items (the sync step's `poll`). */
  async pollPositions(cursor: string | null): Promise<PollResult<RawItem<SamsaraPositionRaw>>> {
    const page = await this.locationsFeed(cursor);
    return {
      items: samsaraPositionItems(page),
      cursor: page.pagination.endCursor || (cursor ?? ''),
      hasMore: page.pagination.hasNextPage,
    };
  }

  /** One page of the stats feed as raw items. */
  async pollStats(cursor: string | null): Promise<PollResult<RawItem<SamsaraStatRaw>>> {
    const page = await this.statsFeed(cursor);
    return {
      items: samsaraStatItems(page),
      cursor: page.pagination.endCursor || (cursor ?? ''),
      hasMore: page.pagination.hasNextPage,
    };
  }

  /** The contract port (contracts §8): normalized positions. */
  asPositionSource(): PositionSource {
    return {
      poll: async (cursor) => {
        const r = await this.pollPositions(cursor);
        return { ...r, items: r.items.flatMap((i) => mapSamsaraPosition(i.payload)) };
      },
    };
  }

  /** The contract port: normalized engine hours / odometer / fuel. */
  asVehicleStatsSource(): VehicleStatsSource {
    return {
      statsSince: async (cursor) => {
        const r = await this.pollStats(cursor);
        return { ...r, items: r.items.flatMap((i) => mapSamsaraStat(i.payload)) };
      },
    };
  }
}
