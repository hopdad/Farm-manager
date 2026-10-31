/**
 * Samsara equipment-feed client (fleet.equipment; docs/contracts-1f.md part B): the asset
 * gateways' locations and stats feeds (./equipment-schemas.ts), with the Samsara API token of
 * `samsaraEndpoint` (sim: the stand-in, replay: the fixture transport, sandbox/live:
 * api.samsara.com). Both are cursor feeds (`pollVersionFeed`'s model: the stored cursor is
 * Samsara's `endCursor`); the stats are two calls of at most 4 types each, so their cursor is
 * one JSON object holding each call's own `endCursor` (a cursor belongs to its `types` set).
 * Rate limits (Samsara's rate-limit page): 5 req/s for the locations feed, 10 req/s for stats;
 * a 429's Retry-After (possibly fractional) is honoured by the HTTP layer.
 */
import {
  type ConnectorConfig,
  replayFetch,
  type SamsaraEndpoint,
  samsaraEndpoint,
} from '../endpoints';
import { type VendorHttpOptions, vendorJson } from '../http';
import type { Mode, PollResult, RawItem } from '../types';
import { equipmentPositionItems, equipmentStatItems } from './equipment-mapper';
import {
  EQUIPMENT_STAT_GROUP_NAMES,
  EQUIPMENT_STAT_GROUPS,
  type EquipmentStatGroup,
  type SamsaraEquipmentFeed,
  type SamsaraEquipmentPositionRaw,
  type SamsaraEquipmentStatRaw,
  samsaraEquipmentFeedSchema,
} from './equipment-schemas';

export type SamsaraEquipmentHttpOptions = Omit<VendorHttpOptions, 'vendor'>;

/** The equipment_stats cursor: each call's own endCursor. */
export interface EquipmentStatsCursor {
  v: 1;
  after: Partial<Record<EquipmentStatGroup, string>>;
}

export function parseEquipmentStatsCursor(cursor: string | null): EquipmentStatsCursor {
  if (cursor?.startsWith('{')) {
    try {
      const v = JSON.parse(cursor) as Partial<EquipmentStatsCursor>;
      if (v.v === 1 && v.after && typeof v.after === 'object') return { v: 1, after: v.after };
    } catch {
      // start over
    }
  }
  return { v: 1, after: {} };
}

export interface SamsaraEquipmentClientOptions {
  http?: SamsaraEquipmentHttpOptions;
  /** Told about every row the schemas dropped (the page is kept). */
  onDropped?: (feed: string, dropped: { index: number; id: string | null; reason: string }) => void;
}

export class SamsaraEquipmentClient {
  readonly endpoint: SamsaraEndpoint;
  private readonly http: SamsaraEquipmentHttpOptions;
  private readonly onDropped: NonNullable<SamsaraEquipmentClientOptions['onDropped']>;

  constructor(endpoint: SamsaraEndpoint, opts: SamsaraEquipmentClientOptions = {}) {
    this.endpoint = endpoint;
    this.http = opts.http ?? {};
    this.onDropped =
      opts.onDropped ??
      ((feed, d) =>
        console.warn(`[samsara] ${feed}: dropped row ${d.index} (${d.id ?? '?'}): ${d.reason}`));
  }

  /** Replay = the same client on the fixture transport (./equipment-replay.ts in samsaraReplayFixtures). */
  static forMode(
    mode: Mode,
    cfg: ConnectorConfig,
    opts: SamsaraEquipmentClientOptions = {},
  ): SamsaraEquipmentClient {
    const http = opts.http ?? {};
    return new SamsaraEquipmentClient(samsaraEndpoint(mode, cfg), {
      ...opts,
      http:
        mode === 'replay' ? { ...http, fetch: replayFetch('samsara', { now: http.now }) } : http,
    });
  }

  private get(path: string, params: Record<string, string | null>): Promise<SamsaraEquipmentFeed> {
    const url = new URL(`${this.endpoint.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    return vendorJson(
      samsaraEquipmentFeedSchema,
      url.toString(),
      {
        method: 'GET',
        headers: { authorization: `Bearer ${this.endpoint.apiToken}`, accept: 'application/json' },
      },
      { ...this.http, vendor: 'samsara' },
    );
  }

  /** GET /fleet/equipment/locations/feed */
  locationsFeed(after: string | null): Promise<SamsaraEquipmentFeed> {
    return this.get('/fleet/equipment/locations/feed', { after });
  }

  /** GET /fleet/equipment/stats/feed for one of the app's calls (≤ 4 types). */
  statsFeed(group: EquipmentStatGroup, after: string | null): Promise<SamsaraEquipmentFeed> {
    return this.get('/fleet/equipment/stats/feed', {
      types: EQUIPMENT_STAT_GROUPS[group].join(','),
      after,
    });
  }

  /** One page of the locations feed as raw items (equipment_positions' `poll`). */
  async pollPositions(
    cursor: string | null,
  ): Promise<PollResult<RawItem<SamsaraEquipmentPositionRaw>>> {
    const page = await this.locationsFeed(cursor || null);
    const r = equipmentPositionItems(page.data);
    for (const d of r.dropped) this.onDropped('equipment locations', d);
    return {
      items: r.items,
      cursor: page.pagination.endCursor || (cursor ?? ''),
      hasMore: page.pagination.hasNextPage,
    };
  }

  /** One page of each stats call as raw items (equipment_stats' `poll`). */
  async pollStats(cursor: string | null): Promise<PollResult<RawItem<SamsaraEquipmentStatRaw>>> {
    const cur = parseEquipmentStatsCursor(cursor);
    const next: EquipmentStatsCursor = { v: 1, after: { ...cur.after } };
    const items: RawItem<SamsaraEquipmentStatRaw>[] = [];
    let hasMore = false;
    for (const group of EQUIPMENT_STAT_GROUP_NAMES) {
      const page = await this.statsFeed(group, cur.after[group] ?? null);
      const r = equipmentStatItems(group, page.data);
      for (const d of r.dropped) this.onDropped(`equipment stats (${group})`, d);
      items.push(...r.items);
      if (page.pagination.endCursor) next.after[group] = page.pagination.endCursor;
      hasMore ||= page.pagination.hasNextPage;
    }
    return { items, cursor: JSON.stringify(next), hasMore };
  }
}
