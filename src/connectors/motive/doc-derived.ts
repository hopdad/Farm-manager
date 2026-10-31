/**
 * The trucks builder's unconfirmed Motive shapes (1f.2, docs/contracts-1f.md part B). Checked
 * against Motive's official OpenAPI 3.1 and developer-docs.gomotive.com on Oct 30, 2026: the
 * host, X-Api-Key, /v1|v2 vehicle_locations (`speed` in mph, the true_* stats in
 * current_location), v3 for Vehicle Gateway units only, /v1/fault_codes with top-level paging,
 * the v2/v3 history window (3 months), 10 concurrent history requests and the webhook scheme
 * (X-KT-Webhook-Signature, HMAC-SHA1) are confirmed, so they are code comments, not entries here.
 * Appended to the admin list by src/connectors/doc-derived.ts; the builder adds its entries.
 */
import type { DocDerivedItem } from '../doc-derived';

export const MOTIVE_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'motive',
    what: 'GET https://api.gomotive.com/v1/vehicle_locations with X-Metric-Units: false',
    confirm:
      'no recorded response yet: the units with the header (the docs say mph and miles; the default without it is ambiguous), whether Ford Pro and Stellantis vehicles appear in v1/v2 lists, the real location cadence',
    file: 'src/connectors/motive/client.ts, src/connectors/motive/schemas.ts',
    basis: 'spec',
  },
  {
    source: 'motive',
    what: 'a TEST MODE key (sandbox mode) against https://api.gomotive.com',
    confirm: 'whether a TEST MODE key reads real fleet data or nothing (it blocks writes only)',
    file: 'src/connectors/endpoints.ts (motiveEndpoint)',
    basis: 'doc',
  },
];
