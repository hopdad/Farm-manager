/**
 * Vendor endpoints and shapes the connectors use that are NOT yet confirmed against a vendor's
 * live docs or a recorded response (plan §5 "Keeping it honest": marked `// doc-derived, confirm`
 * in code and listed on /admin/connectors). Each entry names where the assumption lives; a
 * conformance run against a sandbox (`pnpm connectors:record`, 1a/1f) removes entries.
 *
 * Confirmed (Oct 29, 2026, from Samsara's official SDK @samsarahq/samsara 14.11): Samsara
 * `/fleet/vehicles/locations/feed` and `/fleet/vehicles/stats/feed` paths, `after` /
 * `endCursor` / `hasNextPage` paging, location and stat field names, error body.
 */
import type { ConnectorSource } from './types';

export interface DocDerivedItem {
  source: ConnectorSource;
  /** Endpoint or field, as the client uses it. */
  what: string;
  /** What to confirm. */
  confirm: string;
  /** Where the assumption lives. */
  file: string;
}

export const DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'deere',
    what: 'https://signin.johndeere.com/oauth2/aus78tnlaysMraFhC1t7/v1/{authorize,token}',
    confirm: 'issuer path, scopes (offline_access eq1 org1 ag1), whether refresh tokens rotate',
    file: 'src/connectors/deere/schemas.ts, src/connectors/endpoints.ts',
  },
  {
    source: 'deere',
    what: 'GET {sandboxapi|partnerapi}.deere.com/platform/organizations, /organizations/{id}/machines',
    confirm:
      'Equipment API replacement paths, Accept application/vnd.deere.axiom.v3+json, nextPage links',
    file: 'src/connectors/deere/client.ts',
  },
  {
    source: 'deere',
    what: 'GET /platform/machines/{id}/breadcrumbs?startDate&endDate',
    confirm:
      'path, field names (point.lat/lon, eventTimestamp, speed unit, heading, machineState), page size',
    file: 'src/connectors/deere/schemas.ts',
  },
  {
    source: 'deere',
    what: 'webhook body eventTypeId=subscriptionVerification; X-Deere-Signature',
    confirm: 'verification event shape and Deere webhook signing',
    file: 'src/connectors/webhooks.ts',
  },
  {
    source: 'samsara',
    what: 'X-Samsara-Signature v1=HMAC-SHA256(base64 secret, "v1:<ts>:<body>")',
    confirm: 'webhook signature scheme and timestamp header',
    file: 'src/connectors/webhooks.ts',
  },
  {
    source: 'motive',
    what: 'GET https://api.gomotive.com/v1/vehicle_locations (X-Api-Key)',
    confirm: 'path, auth header, current_location fields (lat, lon, bearing, kph, located_at)',
    file: 'src/connectors/motive/schemas.ts',
  },
];
