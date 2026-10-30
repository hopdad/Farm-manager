/**
 * The trucks builder's unconfirmed Motive shapes (1f.2, docs/contracts-1f.md part B): every
 * Motive path, header and field came from search summaries of developer.gomotive.com (the host
 * was blocked from the build machine). Appended to the admin list by src/connectors/doc-derived.ts.
 * The trucks builder adds its own entries (positions v1/v2/v3, true_* stats, /v1/fault_codes).
 */
import type { DocDerivedItem } from '../doc-derived';

export const MOTIVE_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'motive',
    what: 'GET https://api.gomotive.com/v1/vehicle_locations (X-Api-Key)',
    confirm: 'path, auth header, current_location fields (lat, lon, bearing, kph, located_at)',
    file: 'src/connectors/motive/schemas.ts',
  },
  {
    source: 'motive',
    what: 'MOTIVE_API_BASE default https://api.gomotive.com (api.keeptruckin.com is legacy)',
    confirm: 'the current host, and whether a TEST MODE key uses the same host (sandbox mode)',
    file: 'src/connectors/endpoints.ts (motiveEndpoint)',
  },
];
