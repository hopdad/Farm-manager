/**
 * The trucks builder's unconfirmed MyGeotab shapes (1f.2, docs/contracts-1f.md part B). Checked
 * against my.geotab.com/api.json, developers.geotab.com and mg-api-js 3.0.3 on Oct 30, 2026:
 * POST https://{server}/apiv1 JSON-RPC, Authenticate (service user `userName`, the session
 * reused up to 14 days), GetFeed with fromVersion → toVersion (one version per entity type),
 * GetFeed 60/min per entity type and Authenticate 10/min, errors as HTTP 200 with
 * `error.data.type`, and the free demo database (production servers, ≤ 60 days, ≤ 50 replayed
 * vehicles) are spec-confirmed. Appended to the admin list by src/connectors/doc-derived.ts; the
 * builder adds its entries.
 */
import type { DocDerivedItem } from '../doc-derived';

export const GEOTAB_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'geotab',
    what: 'Authenticate → LoginResult.path (the server to use from then on)',
    confirm:
      'api.json marks `path` deprecated and private ("will be removed"): the client must cope with a host name, "ThisServer" or no path, and fall back to GEOTAB_SERVER when a stored server fails',
    file: 'src/connectors/endpoints.ts (geotabEndpoint), src/connectors/geotab',
    basis: 'spec',
  },
  {
    source: 'geotab',
    what: 'GetFeed LogRecord / StatusData (since 11.119, Mar 30, 2026)',
    confirm:
      "they throw for a limited-scope user (a hauler's service user scoped to some groups): the hauler must grant whole-fleet (CompanyGroup) scope, else the client falls back to Get with device and date windows or DeviceStatusInfo (snapshot diff); whether FaultData and DeviceStatusInfo work under a limited scope",
    file: 'src/connectors/geotab, src/jobs/fleet-geotab.ts',
    basis: 'spec',
  },
  {
    source: 'geotab',
    what: 'StatusData GetFeed (engine hours, odometer, fuel level, ignition by Diagnostic id)',
    confirm:
      'the feed returns every diagnostic (search is ignored): filter to our Diagnostic ids before landing raw rows; the unit of DiagnosticEngineHoursId (read Diagnostic.unitOfMeasure; seconds expected) and of DiagnosticDieselExhaustFluidId; fuel level and engine faults need the GO Plan',
    file: 'src/connectors/geotab',
    basis: 'doc',
  },
  {
    source: 'geotab',
    what: 'OverLimitException (Retry-After) and OEM (Ford, Stellantis) devices',
    confirm:
      'the HTTP status of an OverLimitException (200 or 429); how OEM devices appear (deviceType, productId)',
    file: 'src/connectors/geotab',
    basis: 'doc',
  },
];
