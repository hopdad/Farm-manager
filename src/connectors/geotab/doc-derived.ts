/**
 * The trucks builder's unconfirmed MyGeotab shapes (1f.2, docs/contracts-1f.md part B). Checked
 * against my.geotab.com/api.json, developers.geotab.com and mg-api-js 3.0.3 on Oct 30, 2026:
 * POST https://{server}/apiv1 JSON-RPC, Authenticate (service user `userName`, the session
 * reused up to 14 days, re-authenticated on InvalidUserException), GetFeed with fromVersion →
 * toVersion (one version per entity type; no fromVersion = from now; a full page means more),
 * GetFeed 60/min per entity type and Authenticate 10/min, errors as HTTP 200 with
 * `error.data.type`, the Diagnostic / FailureMode lookups (SPN = Diagnostic.code for
 * SourceJ1939Id, FMI = FailureMode.code; OBD-II = controller prefix + the code in hex), and the
 * free demo database (production servers, ≤ 60 days, ≤ 50 replayed vehicles) are
 * spec-confirmed, so they are code comments, not entries here. Appended to the admin list by
 * src/connectors/doc-derived.ts.
 */
import type { DocDerivedItem } from '../doc-derived';

export const GEOTAB_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'geotab',
    what: 'Authenticate → LoginResult.path (the server to use from then on)',
    confirm:
      'api.json marks `path` deprecated and private ("will be removed"): the client follows a host name, keeps the configured server for "ThisServer" or no path, and re-authenticates at GEOTAB_SERVER when a stored server is unreachable; no recorded LoginResult yet',
    file: 'src/connectors/geotab/client.ts (authenticate, call), src/connectors/geotab/session.ts',
    basis: 'spec',
  },
  {
    source: 'geotab',
    what: 'GetFeed LogRecord / StatusData for a limited-scope user (since 11.119, Mar 30, 2026)',
    confirm:
      "the error type GetFeed throws (the client treats any error that isn't InvalidUser, OverLimit, DbUnavailable or MissingMethod as the restriction and falls back to Get DeviceStatusInfo, last known; it probes GetFeed again after an hour); whether FaultData GetFeed and DeviceStatusInfo (with search.diagnostics, beta) work under a limited scope; the hauler should grant whole-fleet (CompanyGroup) scope",
    file: 'src/connectors/geotab/client.ts (pollPositions, pollStats), src/jobs/fleet-geotab.ts (scopeFallback)',
    basis: 'spec',
  },
  {
    source: 'geotab',
    what: 'StatusData units (DiagnosticEngineHoursId, DiagnosticOdometerId, DiagnosticDieselExhaustFluidId)',
    confirm:
      "engine hours are read in the Diagnostic's unitOfMeasure, seconds assumed when it names none (every other Geotab engine-hours field is in seconds); odometer in meters; DEF only when its Diagnostic says percent; StatusData.data taken as already converted (conversion/offset not applied); fuel level and engine faults need the GO Plan",
    file: 'src/connectors/geotab/mapper.ts (mapGeotabStat)',
    basis: 'doc',
  },
  {
    source: 'geotab',
    what: 'FaultData states and OEM devices',
    confirm:
      'Active/Pending/None read as open, Inactive/Cleared as closed (faultState is to be replaced by FaultStatus); an OBD-II DTC state only for Pending (Active gives no confirmed/permanent); how OEM (Ford, Stellantis) devices appear (deviceType, productId: via stays unchanged)',
    file: 'src/connectors/geotab/mapper.ts (geotabFault, mapGeotabVehicle)',
    basis: 'doc',
  },
  {
    source: 'geotab',
    what: 'OverLimitException (Retry-After)',
    confirm:
      'the HTTP status it comes with (200 or 429: both are handled, Retry-After honoured either way); whether calls inside ExecuteMultiCall count separately (the client makes none)',
    file: 'src/connectors/geotab/client.ts',
    basis: 'doc',
  },
];
