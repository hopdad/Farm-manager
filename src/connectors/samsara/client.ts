/**
 * Samsara live client (sim mode = this client against `${VENDOR_SIM_URL}/samsara`).
 *
 * Cursor feeds: the first call (no cursor) returns the latest event per vehicle plus an
 * endCursor; later calls pass it as `after` and get only newer events; `hasNextPage` says more
 * are ready right now (runSyncStep keeps polling while it is true, within the job budget).
 * The stored cursor is the endCursor string; an empty endCursor keeps the previous one.
 *
 * Three feeds, three cursors (a Samsara cursor belongs to its `types` set): positions
 * (/fleet/vehicles/locations/feed), stats (engine seconds, fuel, odometer: the 3-types limit) and,
 * slice 1f, fault codes (/fleet/vehicles/stats/feed?types=faultCodes: one reading per change, the
 * vehicle's complete active set; ./mapper.ts `mapSamsaraFaults`).
 */
import {
  type ConnectorConfig,
  replayFetch,
  type SamsaraEndpoint,
  samsaraEndpoint,
} from '../endpoints';
import { type VendorHttpOptions, vendorJson } from '../http';
import type {
  Mode,
  NormalizedVehicleStat,
  PollResult,
  PositionSource,
  RawItem,
  VehicleStatsSource,
} from '../types';
import {
  mapSamsaraFaults,
  mapSamsaraPosition,
  mapSamsaraStat,
  samsaraFaultItems,
  samsaraPositionItems,
  samsaraStatItems,
} from './mapper';
import {
  SAMSARA_FAULT_TYPE,
  SAMSARA_STAT_TYPES,
  type SamsaraFaultCodesFeed,
  type SamsaraFaultRaw,
  type SamsaraLocationsFeed,
  type SamsaraPositionRaw,
  type SamsaraStatRaw,
  type SamsaraStatsFeed,
  samsaraFaultCodesFeedSchema,
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

  /**
   * The client for a connector mode. Replay (contracts-m1 §10) is this same client with the
   * fixture transport (src/connectors/samsara/replay.ts), time-shifted on the job's clock.
   */
  static forMode(mode: Mode, cfg: ConnectorConfig, http: SamsaraHttpOptions = {}): SamsaraClient {
    if (mode === 'replay') {
      return new SamsaraClient(samsaraEndpoint(mode, cfg), {
        ...http,
        fetch: replayFetch('samsara', { now: http.now }),
      });
    }
    return new SamsaraClient(samsaraEndpoint(mode, cfg), http);
  }

  private get<T>(
    schema:
      | typeof samsaraLocationsFeedSchema
      | typeof samsaraStatsFeedSchema
      | typeof samsaraFaultCodesFeedSchema,
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

  /** GET /fleet/vehicles/stats/feed?types=faultCodes (its own call and cursor). */
  faultCodesFeed(after: string | null): Promise<SamsaraFaultCodesFeed> {
    return this.get(samsaraFaultCodesFeedSchema, '/fleet/vehicles/stats/feed', {
      after,
      types: SAMSARA_FAULT_TYPE,
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

  /** One page of the fault-codes feed as raw items (one reading each; stream `faults`). */
  async pollFaults(cursor: string | null): Promise<PollResult<RawItem<SamsaraFaultRaw>>> {
    const page = await this.faultCodesFeed(cursor);
    return {
      items: samsaraFaultItems(page),
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

  /** The vendor-neutral port's `faults` (1f.2): `snapshot` reports in the one fault model. */
  asFaultsSource(): { faults(cursor: string | null): Promise<PollResult<NormalizedVehicleStat>> } {
    return {
      faults: async (cursor) => {
        const r = await this.pollFaults(cursor);
        return { ...r, items: r.items.flatMap((i) => mapSamsaraFaults(i.payload)) };
      },
    };
  }
}
