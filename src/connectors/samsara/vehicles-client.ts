/**
 * Samsara's vehicle list client (slice 1f.2, terminal-pickups; the pickups route,
 * docs/contracts-1f.md §B.1): `GET /fleet/vehicles` with each vehicle's tags (the vehicle kind)
 * and gateway (the via), for fleet.vehicles (CONNECTOR_SAMSARA). A client of its own beside
 * fleet-faults' SamsaraClient (./client.ts) so neither file changes for the other; it uses the
 * same endpoint resolver, the same token and the same replay transport (./replay.ts lists this
 * stream's fixtures, ./vehicles-replay.ts).
 *
 * The SNAPSHOT-DIFF model (src/connectors/sync-models.ts): the list is the vendor's current
 * state; the cursor keeps a fingerprint per vehicle and a poll returns the vehicles whose name,
 * tags, make, model, year, VIN or gateway changed. Pages are followed with `after` = the previous
 * page's `endCursor` while `hasNextPage` (limit 512, Samsara's maximum), at most
 * SAMSARA_VEHICLES_MAX_PAGES. Only the vehicles the farm maps are landed (`only`); a vehicle the
 * lenient schema can't read is dropped and logged with its id.
 */
import {
  type ConnectorConfig,
  replayFetch,
  type SamsaraEndpoint,
  samsaraEndpoint,
} from '../endpoints';
import { type VendorHttpOptions, vendorJson } from '../http';
import { fingerprint, pollSnapshotDiff } from '../sync-models';
import type { Mode, PollResult, RawItem } from '../types';
import {
  SAMSARA_VEHICLES_LIMIT,
  type SamsaraVehicle,
  type SamsaraVehicleRaw,
  type SamsaraVehiclesPage,
  samsaraVehicleSchema,
  samsaraVehiclesPageSchema,
} from './vehicles-schemas';

/** Most pages one list read follows (512 per page). */
export const SAMSARA_VEHICLES_MAX_PAGES = 20;

export interface SamsaraVehiclesClientOptions {
  /** Keep only these Samsara vehicle ids (the ones the farm maps); null/undefined = all. */
  only?: ReadonlySet<string> | null;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class SamsaraVehiclesClient {
  readonly endpoint: SamsaraEndpoint;
  private readonly http: Omit<VendorHttpOptions, 'vendor'>;
  private readonly opts: SamsaraVehiclesClientOptions;

  constructor(
    endpoint: SamsaraEndpoint,
    http: Omit<VendorHttpOptions, 'vendor'> = {},
    opts: SamsaraVehiclesClientOptions = {},
  ) {
    this.endpoint = endpoint;
    this.http = http;
    this.opts = opts;
  }

  static forMode(
    mode: Mode,
    cfg: ConnectorConfig,
    http: Omit<VendorHttpOptions, 'vendor'> = {},
    opts: SamsaraVehiclesClientOptions = {},
  ): SamsaraVehiclesClient {
    if (mode === 'replay') {
      return new SamsaraVehiclesClient(
        samsaraEndpoint(mode, cfg),
        { ...http, fetch: replayFetch('samsara', { now: http.now }) },
        opts,
      );
    }
    return new SamsaraVehiclesClient(samsaraEndpoint(mode, cfg), http, opts);
  }

  private page(after: string | null): Promise<SamsaraVehiclesPage> {
    const u = new URL(`${this.endpoint.baseUrl}/fleet/vehicles`);
    u.searchParams.set('limit', String(SAMSARA_VEHICLES_LIMIT));
    if (after) u.searchParams.set('after', after);
    return vendorJson(
      samsaraVehiclesPageSchema,
      u.toString(),
      {
        method: 'GET',
        headers: { authorization: `Bearer ${this.endpoint.apiToken}`, accept: 'application/json' },
      },
      { ...this.http, vendor: 'samsara' },
    );
  }

  /** Every vehicle of GET /fleet/vehicles (all pages). */
  async vehicles(): Promise<SamsaraVehicle[]> {
    const out: SamsaraVehicle[] = [];
    let after: string | null = null;
    for (let i = 0; i < SAMSARA_VEHICLES_MAX_PAGES; i++) {
      const page = await this.page(after);
      for (const raw of page.data) {
        const r = samsaraVehicleSchema.safeParse(raw);
        if (r.success) out.push(r.data);
        else {
          const id = (raw as { id?: unknown } | null)?.id;
          this.opts.log?.('samsara: unreadable vehicle dropped', {
            id: typeof id === 'string' ? id : null,
          });
        }
      }
      const next = page.pagination.endCursor;
      if (!page.pagination.hasNextPage || !next || next === after) return out;
      after = next;
    }
    this.opts.log?.('samsara: vehicle list cut at the page limit', {
      pages: SAMSARA_VEHICLES_MAX_PAGES,
    });
    return out;
  }

  /** Stream 'vehicles': each mapped vehicle whose name, tags, make, model, year, VIN or gateway changed. */
  async pollVehicles(cursor: string | null): Promise<PollResult<RawItem<SamsaraVehicleRaw>>> {
    const only = this.opts.only;
    // The poll time in the id: a vehicle that goes back to an earlier version (tags A → B → A)
    // lands again (the same id and payload would be dropped by raw_events' dedupe, and the kind
    // would stay B). Only versions that moved are emitted, so this lands nothing twice.
    const at = (this.http.now?.() ?? new Date()).getTime();
    const items = (await this.vehicles())
      .filter((v) => !only || only.has(v.id))
      .map((vehicle) => ({
        externalId: `${vehicle.id}:vehicle:${vehicleVersion(vehicle)}:${at}`,
        payload: { vehicle },
      }));
    const r = await pollSnapshotDiff({
      cursor,
      fetchSnapshot: async () => items,
      keyOf: (i) => i.payload.vehicle.id,
      versionOf: (i) => vehicleVersion(i.payload.vehicle),
      mode: 'changed',
    });
    return { items: r.items, cursor: r.cursor, hasMore: false };
  }
}

/** A fingerprint of what the kind and via depend on (and what an admin would see change). */
export function vehicleVersion(v: SamsaraVehicle): string {
  return fingerprint(
    JSON.stringify([
      v.name ?? null,
      (v.tags ?? []).map((t) => t.name).sort(),
      v.make ?? null,
      v.model ?? null,
      v.year ?? null,
      v.vin ?? null,
      v.gateway?.model ?? null,
    ]),
  );
}
