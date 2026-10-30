/**
 * Vendor endpoints and shapes the connectors use that are NOT yet confirmed against a vendor's
 * live docs or a recorded response (plan §5 "Keeping it honest": marked `// doc-derived, confirm`
 * in code and listed on /admin/connectors). Each entry names where the assumption lives; a
 * conformance run against a sandbox (`pnpm connectors:record`, 1a/1f) removes entries.
 *
 * Confirmed (Oct 29, 2026, from Samsara's official SDK @samsarahq/samsara 14.11): Samsara
 * `/fleet/vehicles/locations/feed` and `/fleet/vehicles/stats/feed` paths, `after` /
 * `endCursor` / `hasNextPage` paging, location and stat field names, error body.
 *
 * Read from Deere's published OpenAPI documents (developer.deere.com dev-docs; the portal's raw
 * specs as mirrored in ProductOfAmerica/deere-sdk specs/raw, fetched by that project Oct 19,
 * 2026) and recorded sandbox responses in RealmFive/my_john_deere_api (1a, for the replay
 * fixtures): the breadcrumb, field, boundary, field-operation, measurement and flag shapes in
 * src/connectors/deere/schemas.ts. Still to confirm against OUR sandbox org (below).
 */
import { AEMP_DOC_DERIVED } from './aemp/doc-derived';
import { CNH_DOC_DERIVED } from './cnh/doc-derived';
import { DEERE_FIELDS_DOC_DERIVED } from './deere/fields/doc-derived';
import { DEERE_OPS_DOC_DERIVED } from './deere/ops/doc-derived';
import { GEOTAB_DOC_DERIVED } from './geotab/doc-derived';
import { MOTIVE_DOC_DERIVED } from './motive/doc-derived';
import { NWS_DOC_DERIVED } from './nws/doc-derived';
import { SAMSARA_DOC_DERIVED } from './samsara/doc-derived';
import { SAMSARA_EQUIPMENT_DOC_DERIVED } from './samsara/equipment-doc-derived';
import { TERMINAL_DOC_DERIVED } from './terminal/doc-derived';
import type { ConnectorSource } from './types';
import { VEHICLES_DOC_DERIVED } from './vehicles/doc-derived';

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
    what: "Deere's Equipment API host (equipmentapi.deere.com/isg/…), the replacement for the /platform machines paths",
    confirm:
      '1f reads equipment from GET /platform/organizations/{orgId}/machines (equipmentType, equipmentMake, equipmentModel names) and engine hours from GET /platform/machines/{id}/engineHours; if our app must use the Equipment API host instead, sync-health adds an equipmentBase to DeereEndpoints and the stand-in serves it (docs/contracts-1f.md §7.1)',
    file: 'src/connectors/endpoints.ts, src/connectors/deere/client.ts, src/sim/vendors/deere/routes.ts',
  },
  {
    source: 'deere',
    what: 'GET /platform/machines/{principalId}/breadcrumbs?startDate&endDate',
    confirm:
      'shapes are from the Machine Locations OpenAPI (speed {valueAsDouble, unit km1hr-1}, heading {valueAsInteger}, machineState {value}); confirm units as our org sends them, page size, whether startDate/endDate are inclusive (the client filters to its window); the stand-in sends these shapes since M1',
    file: 'src/connectors/deere/schemas.ts, src/sim/vendors/deere/routes.ts',
  },
  {
    source: 'deere',
    what: 'GET /platform/organizations/{orgId}/fields, /boundaries, /fields/{fieldId}/boundaries, /fields/{fieldId}/fieldOperations, /fieldOperations/{id}/measurementTypes, /organizations/{orgId}/flags',
    confirm:
      'documented paths and shapes used by the replay fixtures (1a) and the 1f syncs: confirm with `pnpm connectors:record` (embed parameters, paging sizes, unit ids, flag geometry string vs object)',
    file: 'src/connectors/deere/schemas.ts, src/connectors/deere/fixtures/build.ts',
  },
  {
    source: 'deere',
    what: 'GET /platform/fieldOperations/{operationId}/boundary (operation coverage)',
    confirm:
      'Deere answers 400 when the field already has an active boundary; confirm, and read coverage from the shapefile (GET /fieldOps/{id}?shapeType=Polygon) at 1f where it does',
    file: 'src/connectors/deere/client.ts',
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
  // NWS (1b): api.weather.gov was unreachable from the build machine; one live run confirms.
  ...NWS_DOC_DERIVED,
  // 1f (docs/contracts-1f.md §1): each builder keeps its own list; this file (sync-health) only
  // appends them and drops entries a recording confirms.
  ...DEERE_FIELDS_DOC_DERIVED,
  ...DEERE_OPS_DOC_DERIVED,
  ...SAMSARA_DOC_DERIVED,
  // 1f.2 (docs/contracts-1f.md part B): one list per builder file, appended here.
  ...MOTIVE_DOC_DERIVED,
  ...GEOTAB_DOC_DERIVED,
  ...AEMP_DOC_DERIVED,
  ...SAMSARA_EQUIPMENT_DOC_DERIVED,
  ...CNH_DOC_DERIVED,
  ...TERMINAL_DOC_DERIVED,
  ...VEHICLES_DOC_DERIVED,
];
