/**
 * The trucks builder's unconfirmed Motive shapes (1f.2, docs/contracts-1f.md part B). Checked
 * against Motive's official OpenAPI 3.1 and developer-docs.gomotive.com on Oct 30, 2026: the
 * host, X-Api-Key, /v1|v2 vehicle_locations (`speed` in mph, the true_* stats in
 * current_location), v3 for Vehicle Gateway units only (`kph`, `vehicle_state`), /v1/companies
 * (company.id), /v1/fault_codes with top-level paging, the v2/v3 history window (3 months), 10
 * concurrent history requests and the webhook scheme (X-KT-Webhook-Signature, HMAC-SHA1) are
 * confirmed, so they are code comments, not entries here. Appended to the admin list by
 * src/connectors/doc-derived.ts.
 */
import type { DocDerivedItem } from '../doc-derived';

export const MOTIVE_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'motive',
    what: 'GET https://api.gomotive.com/v2/vehicle_locations and /v3/vehicle_locations with X-Metric-Units: false',
    confirm:
      "no recorded response yet: the units with the header (the docs say mph and miles; the default without it is ambiguous; whether v3's kph follows the header), v1 vs v2 (identical in the spec; v2 is read, as Motive's maintenance guide does), whether Ford Pro and Stellantis vehicles appear in the lists, the real location cadence",
    file: 'src/connectors/motive/client.ts, src/connectors/motive/schemas.ts',
    basis: 'spec',
  },
  {
    source: 'motive',
    what: 'GET /v1/fault_codes?start_date=&end_date= (the last 7 days, polled as delta reports)',
    confirm:
      "the `network` value of a J1939 fault (`j1939` assumed: Motive's examples show only `obdii` and a `j1587/j1708` record labelled SPN-<n>), whether the dates filter on the first or the last observation, whether an open fault older than the window is still listed; Motive documents no lamp states, so a J1939 fault's severity is `info` (decision 1f-2 with lamps unknown)",
    file: 'src/connectors/motive/client.ts (faultCodes), src/connectors/motive/mapper.ts (motiveFault)',
    basis: 'doc',
  },
  {
    source: 'motive',
    what: 'GET /v1/vehicles + /v1/groups: group names as the kind tags (VEHICLE_KIND_TAGS)',
    confirm:
      "Motive has groups, not tags: a hauler's group names decide the kind; whether a vehicle's data source (gateway vs Ford Pro / Stellantis) shows anywhere in the API (via stays unchanged)",
    file: 'src/connectors/motive/client.ts (vehicleList), src/connectors/motive/mapper.ts',
    basis: 'spec',
  },
  {
    source: 'motive',
    what: 'rate limits and HTTP 429',
    confirm:
      "no global limit and no Retry-After header are documented; the client reads a body's \"Retry after N seconds\" (Motive's documented 429 bodies differ per endpoint) and otherwise lets the stream's cadence back off",
    file: 'src/connectors/motive/client.ts (motiveRetryAfter)',
    basis: 'doc',
  },
  {
    source: 'motive',
    what: 'a TEST MODE key (sandbox mode) against https://api.gomotive.com',
    confirm: 'whether a TEST MODE key reads real fleet data or nothing (it blocks writes only)',
    file: 'src/connectors/endpoints.ts (motiveEndpoint)',
    basis: 'doc',
  },
];
