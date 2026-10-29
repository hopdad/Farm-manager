/**
 * Motive client: THIN placeholder until D3 (plan §5). Reads each vehicle's current location
 * (no history feed), so the cursor is the newest `located_at` seen PER VEHICLE (JSON
 * `{"<vehicle id>":"<iso>"}`); a vehicle's location at or before its own watermark is skipped.
 * (One global watermark would drop every truck whose ELD reports a little later than the
 * fastest one.) Enough for ELD_VENDOR=motive to drive the board in sim mode.
 */

import { normalizeHeading } from '../../domain/fleet';
import { type ConnectorConfig, type MotiveEndpoint, motiveEndpoint } from '../endpoints';
import { type VendorHttpOptions, vendorJson } from '../http';
import type { Mode, NormalizedPosition, PollResult, PositionSource, RawItem } from '../types';
import {
  type MotivePositionRaw,
  motivePositionRawSchema,
  motiveVehicleLocationsSchema,
} from './schemas';

const PER_PAGE = 100;
const MAX_PAGES = 20;
const KMH_PER_MPH = 1.609344;

export function mapMotivePosition(raw: unknown): NormalizedPosition[] {
  const p = motivePositionRawSchema.parse(raw);
  const l = p.location;
  return [
    {
      source: 'motive',
      externalMachineId: p.id,
      sourceOrg: '',
      ts: new Date(l.located_at).toISOString(),
      lng: l.lon,
      lat: l.lat,
      heading: l.bearing == null ? null : normalizeHeading(l.bearing),
      speedMph: l.kph == null ? null : Math.max(0, Math.round((l.kph / KMH_PER_MPH) * 10) / 10),
      engineOn: null,
      positionSource: 'eld',
    },
  ];
}

/** Per-vehicle watermarks from a cursor ('' or anything that isn't the JSON map: none yet). */
export function parseMotiveCursor(cursor: string | null): Record<string, string> {
  if (!cursor?.startsWith('{')) return {};
  try {
    const parsed = JSON.parse(cursor) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [id, iso] of Object.entries(parsed)) {
      if (typeof iso === 'string' && !Number.isNaN(Date.parse(iso))) out[id] = iso;
    }
    return out;
  } catch {
    return {};
  }
}

export class MotiveClient {
  readonly endpoint: MotiveEndpoint;
  private readonly http: Omit<VendorHttpOptions, 'vendor'>;

  constructor(endpoint: MotiveEndpoint, http: Omit<VendorHttpOptions, 'vendor'> = {}) {
    this.endpoint = endpoint;
    this.http = http;
  }

  static forMode(
    mode: Mode,
    cfg: ConnectorConfig,
    http: Omit<VendorHttpOptions, 'vendor'> = {},
  ): MotiveClient {
    return new MotiveClient(motiveEndpoint(mode, cfg), http);
  }

  async pollPositions(cursor: string | null): Promise<PollResult<RawItem<MotivePositionRaw>>> {
    const seen = parseMotiveCursor(cursor);
    const items: RawItem<MotivePositionRaw>[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const u = new URL(`${this.endpoint.baseUrl}/v1/vehicle_locations`);
      u.searchParams.set('per_page', String(PER_PAGE));
      u.searchParams.set('page_no', String(page));
      const body = await vendorJson(
        motiveVehicleLocationsSchema,
        u.toString(),
        {
          method: 'GET',
          headers: { 'x-api-key': this.endpoint.apiKey, accept: 'application/json' },
        },
        { ...this.http, vendor: 'motive' },
      );
      for (const { vehicle } of body.vehicles) {
        const loc = vehicle.current_location;
        if (!loc) continue;
        const t = Date.parse(loc.located_at);
        const since = seen[vehicle.id];
        if (since !== undefined && !(t > Date.parse(since))) continue;
        const iso = new Date(t).toISOString();
        seen[vehicle.id] = iso;
        items.push({
          externalId: `${vehicle.id}:${iso}`,
          payload: { id: vehicle.id, number: vehicle.number ?? null, location: loc },
        });
      }
      const p = body.pagination;
      if (!p || p.page_no * p.per_page >= p.total || body.vehicles.length === 0) break;
    }
    return { items, cursor: JSON.stringify(seen), hasMore: false };
  }

  asPositionSource(): PositionSource {
    return {
      poll: async (cursor) => {
        const r = await this.pollPositions(cursor);
        return { ...r, items: r.items.flatMap((i) => mapMotivePosition(i.payload)) };
      },
    };
  }
}
