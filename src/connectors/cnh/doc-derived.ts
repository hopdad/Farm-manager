/**
 * The machines builder's CNH FieldOps assumptions (1f.2, docs/contracts-1f.md part B): a client
 * to CNH's published OpenAPI (SwaggerHub CNH/FieldOps-API 1.0.0, linked from develop.cnh.com),
 * read Oct 30, 2026. Spec-confirmed (waiting only for a staging recording, which CNH needs before
 * sandbox or live use): the hosts and paths per environment, the Auth0 authorize parameters
 * (audience and connection per environment), client_secret_post, the Ocp-Apim-Subscription-Key
 * header, the EULA 403 text, the ISO-style Fleet and series paths and roots. Still doc-derived:
 * what cnh.md §7.2 lists as unconfirmed. Appended to the admin list by
 * src/connectors/doc-derived.ts. The machines builder's client (./client.ts, ./oauth.ts,
 * ./sync.ts) added the entries after the first four.
 */
import type { DocDerivedItem } from '../doc-derived';

export const CNH_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'cnh',
    what: 'https://{stg.}api-data.cnh.com/v1 and https://{stg.}identity.cnhind.com (authorize, oauth/token, oauth/revoke)',
    confirm:
      'one staging recording (pnpm connectors:record cnh in sandbox mode, with CNH virtual vehicles on a staging account) before live use; the token response body (the spec documents {}) and whether refresh tokens rotate',
    file: 'src/connectors/endpoints.ts (cnhEndpoints), src/connectors/cnh',
    basis: 'spec',
  },
  {
    source: 'cnh',
    what: 'ISO-style telemetry: GET /Fleet/{page}, /Fleet/Equipment/{vin}/{Series}/{start}/{end}/{page}',
    confirm:
      'XML is the only documented format (whether Accept: application/json gets JSON); lower-case location keys (match case-insensitively); whether one VIN without an accepted EULA fails a whole /Fleet page; CumulativeFuelUsed semantics (lifetime or 24 h)',
    file: 'src/connectors/cnh',
    basis: 'doc',
  },
  {
    source: 'cnh',
    what: 'CautionCodes / Faults severity strings, equipment brand codes, boundary area units',
    confirm:
      'severity values are not enumerated (unknown → warning, the raw value kept); brand codes (CSAG, …) are not listed; boundary `area` is square metres or acres depending on the page (compute from the geometry)',
    file: 'src/connectors/cnh',
    basis: 'doc',
  },
  {
    source: 'cnh',
    what: 'ETag deltas on farm-setup lists; webhook payloads (Azure Event Grid)',
    confirm:
      'how a deletion shows in a farm-setup delta; whether a webhook POST is an array or one object and its eventType names (Field vs FarmField) — webhooks need a public endpoint (MD)',
    file: 'src/connectors/cnh',
    basis: 'doc',
  },
  {
    source: 'cnh',
    what: "a 401 without APIM's AzureApiManagementKey header is an expired or invalid access token",
    confirm:
      'whether CNH tells an expired token from a key mismatch (the client refreshes the token once for any other 401, and reports a subscription-key 401 as configuration); the 401 body and WWW-Authenticate of an expired token',
    file: 'src/connectors/cnh/client.ts',
    basis: 'doc',
  },
  {
    source: 'cnh',
    what: 'GET /Fleet/Equipment/{vin} answers a Fleet with one Equipment; a 403 EULA on /Fleet/{page} falls back to it per VIN',
    confirm:
      "the single-machine snapshot's root element; whether /Fleet/{page} leaves non-EULA VINs out (the stand-in's assumption) or fails the page",
    file: 'src/connectors/cnh/client.ts (fleetEquipment), src/connectors/cnh/sync.ts (pollCnhFleet)',
    basis: 'doc',
  },
  {
    source: 'cnh',
    what: 'series windows: Locations at most 24 h back, CautionCodes and Faults at most 7 days; CautionCodes with verbose=true',
    confirm:
      'CNH documents no maximum window for the ISO series (Metrics: "keep the date range to just one day"); whether CautionCodes without verbose=true still carry Severity and Active',
    file: 'src/connectors/cnh/sync.ts, src/connectors/cnh/client.ts',
    basis: 'doc',
  },
];
