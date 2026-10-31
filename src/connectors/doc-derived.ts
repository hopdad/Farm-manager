/**
 * Vendor endpoints and shapes the connectors use that are NOT yet confirmed against a recorded
 * response (plan §5 "Keeping it honest": marked `// doc-derived, confirm` in code and listed on
 * /admin/connectors). Each entry names where the assumption lives; a conformance run against a
 * sandbox (`pnpm connectors:record`, 1f) removes entries.
 *
 * `basis` (1f.2) tells two kinds apart:
 *   'spec'  read from the vendor's OWN published spec or docs (an OpenAPI or api.json, an SDK,
 *           a developer-portal page): only a recorded response is missing;
 *   'doc'   still doc-derived: the vendor's docs are silent or contradict themselves, or only a
 *           third party or a search summary says so (the default).
 *
 * Checked against the vendors' official docs and specs on Oct 30, 2026 (network open): Deere's
 * developer portal and its spec feed (developer.deere.com/devDoc/apiDetails), the Okta discovery
 * document; Samsara's OpenAPI (developers.samsara.com/openapi/samsara-api.json) and SDK; Motive's
 * OpenAPI 3.1; MyGeotab's api.json; the ISO 15143-3 edition-1 XSDs, Trackunit's and Samsara's
 * AEMP specs; CNH's FieldOps OpenAPI (SwaggerHub CNH/FieldOps-API 1.0.0); Terminal's OpenAPI 3.1.
 * Confirmed then and dropped from this list: Samsara's feed paths, cursor paging, field names,
 * 4xx error body and webhook signature; Deere's OAuth issuer and paths, `ag2` for field
 * operations, the Equipment API host, `principalId` breadcrumbs, `pageOffset`/`itemLimit` paging,
 * the Connections rels and its webhook scheme; Motive's host and webhook signature; Terminal's
 * hosts.
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
  /**
   * 1f.2: 'spec' = from the vendor's own published spec or docs, waiting only for a recorded
   * response; 'doc' (default) = still doc-derived (docs silent or contradictory, a third party).
   */
  basis?: 'spec' | 'doc';
}

export const DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'deere',
    what: 'OAuth refresh: https://signin.johndeere.com/oauth2/aus78tnlaysMraFhC1t7/v1/token (refresh_token grant)',
    confirm:
      'whether a refresh returns a new refresh token (Deere describes a long-lived one, 365 days idle), and whether it needs redirect_uri and scope; that a grant with offline_access ag1 ag2 eq1 sees every endpoint we call',
    file: 'src/connectors/deere/oauth.ts, src/connectors/deere/schemas.ts (DEERE_SCOPES)',
    basis: 'spec',
  },
  {
    source: 'deere',
    what: 'GET https://equipmentapi.deere.com/isg/equipment?organizationIds=&categories=Machine&capableOf=Connectivity (Accept: application/json)',
    confirm:
      "whether its nextPage links are absolute or relative (the spec says relative, its example absolute; the client resolves both), whether it refuses the platform's axiom Accept type, the real isgType names (GET /equipmentISGTypes?category=machine), principalId as a string or an integer",
    file: 'src/connectors/deere/client.ts (machines), src/connectors/deere/schemas.ts',
    basis: 'spec',
  },
  {
    source: 'deere',
    what: 'the deprecated GET /platform/organizations/{orgId}/machines (not called since 1f.2)',
    confirm:
      'nothing to confirm for the app: Deere began deprecating it in January 2025 with no published shut-off date; the Equipment API replaces it',
    file: 'src/connectors/deere/client.ts',
    basis: 'spec',
  },
  {
    source: 'deere',
    what: 'GET /platform/machines/{principalId}/breadcrumbs?startDate&endDate&itemLimit=100',
    confirm:
      "whether startDate/endDate are inclusive (the client filters to its window), the meaning of machineState.rawState (Deere's own example sends {rawState:1}), the real breadcrumb cadence, whether itemLimit above 10 is honoured on breadcrumbs",
    file: 'src/connectors/deere/schemas.ts, src/connectors/deere/client.ts',
    basis: 'spec',
  },
  {
    source: 'deere',
    what: 'GET /platform/organizations/{orgId}/fields, /boundaries, /fields/{fieldId}/boundaries, /fields/{fieldId}/fieldOperations (scope ag2), /fieldOperations/{id}/measurementTypes, /organizations/{orgId}/flags',
    confirm:
      "unit ids as our org's unit preference sends them; archived boundaries, fields and flags need recordFilter=all; whether fieldOperationType is case-sensitive",
    file: 'src/connectors/deere/schemas.ts, src/connectors/deere/fixtures/build.ts',
    basis: 'spec',
  },
  {
    source: 'deere',
    what: 'organizations: `connections` (needs approval) vs `manage_connections` / `manage_connection` (connected) links; a 403 with x-deere-terms-location',
    confirm:
      'which rels a connected org carries (both manage spellings appear in the docs), whether partner (customer) orgs list with member: false, the terms-location 403 in practice',
    file: 'src/connectors/deere/orgs.ts',
    basis: 'spec',
  },
  {
    source: 'deere',
    what: 'Deere ISO 15143-3: https://partneraemp.deere.com/Fleet/{page} (sandbox https://sandboxaemp.deere.com), the Deere user grant (eq1 offline_access)',
    confirm:
      'whether Accept: application/json is served (only XML is documented); a Locations or fault series (only /Fleet is documented)',
    file: 'src/config.ts (AEMP_PROVIDERS, auth deere_oauth), src/connectors/endpoints.ts',
    basis: 'spec',
  },
  {
    source: 'deere',
    what: "a 403's kind from its text: 'Access Denied' (org not connected), 'The client does not have a proper access for this API' (scope or licence), 'Requested org is in a restricted state' + X-Deere-Terms-Location (terms); the Equipment API's errors as a bare array [{ code, message }]",
    confirm:
      'the real messages on both APIs (deereDenialOf matches scope/licence/"proper access" in the text), and that an unapproved org answers the Equipment API with the same 403',
    file: 'src/connectors/deere/orgs.ts (deereDenialOf), src/connectors/http.ts (errorDetail)',
    basis: 'spec',
  },
  {
    source: 'deere',
    what: 'Deere Connections: https://connections.deere.com/connections/{clientId}/select-organizations?redirect_uri=<PUBLIC_URL>/admin/connectors',
    confirm:
      'that Deere sends the person back to /admin/connectors once that URL is registered as a Redirect URI in the app profile (the parameter name is documented)',
    file: 'src/connectors/deere/connections.ts (approvalLink)',
    basis: 'spec',
  },
  {
    source: 'deere',
    what: 'the daily call limit (DEERE_DAILY_CALL_BUDGET, decision 4)',
    confirm:
      "Deere publishes no per-day limit beyond the sandbox's 150,000 calls a month; the production limit comes with the production-access agreement (or a 429's Retry-After)",
    file: 'src/connectors/call-budget.ts, src/connectors/deere/call-shares.ts',
    basis: 'doc',
  },
  {
    source: 'samsara',
    what: 'error bodies: {message, requestId} on 4xx, a plain string on 5xx; Retry-After in fractional seconds',
    confirm: 'nothing beyond a recording: both are documented (the 5xx string is read leniently)',
    file: 'src/connectors/http.ts (errorDetail, parseRetryAfter)',
    basis: 'spec',
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
