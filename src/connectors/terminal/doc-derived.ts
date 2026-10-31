/**
 * The terminal-pickups builder's Terminal assumptions (1f.2, docs/contracts-1f.md part B §B.5).
 * Checked against Terminal's OpenAPI 3.1 (api.withterminal.com/tsp/openapi) and
 * docs.withterminal.com on Oct 30, 2026: both hosts, Bearer + Connection-Token, GET /connections
 * (each row carries its token), /providers (no key), the list shape `{ results, next? }`, the
 * flat error body, fractional Retry-After, metric units, the fault events' protocols and states
 * are spec-confirmed. `spec` = from Terminal's own spec or docs, only a recorded response is
 * missing; `doc` = still unconfirmed. Appended to the admin list by src/connectors/doc-derived.ts.
 */
import type { DocDerivedItem } from '../doc-derived';

export const TERMINAL_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'terminal',
    what: "history, stats and fault events (Terminal's own sync: /vehicles/{id}/locations, /stats/historical, /fault-codes/events)",
    confirm:
      "Terminal's sync cadence (how stale they get: the client re-reads a 24 h lookback every run, Terminal advises 24-48 h, and emits what Terminal stored since its last run by metadata.modifiedAt), whether engine_runtime is a cumulative meter (read as one: the spec's 1234.5 ms example isn't), what fault status `pending` means (kept open, as vendorSeverity context), which providers never send `closed` (the 24 h age-out closes them)",
    file: 'src/connectors/terminal/client.ts, src/connectors/terminal/mapper.ts',
    basis: 'doc',
  },
  {
    source: 'terminal',
    what: 'sandbox access and which providers our haulers use',
    confirm:
      'sandbox is for Terminal customers only (a sales call); the providers behind real connections decide the capability rows (/providers, stored for /admin/connectors); the application permission scopes our plan includes (vehicle-location:read, vehicle-location:latest:read, vehicle-stats:*:read, fault-codes:read)',
    file: 'src/connectors/endpoints.ts (terminalEndpoint), src/jobs/fleet-terminal.ts',
    basis: 'doc',
  },
  {
    source: 'terminal',
    what: 'metric units: odometer km, speed km/h, engine runtime ms, fuel %; GET /vehicles/locations carries odometer, fuel, engineState, engineRuntime',
    confirm:
      'a recorded response; which providers fill the latest location\'s counters ("attribute coverage is not yet tracked for this model")',
    file: 'src/connectors/terminal/mapper.ts',
    basis: 'spec',
  },
  {
    source: 'terminal',
    what: 'FaultCodeEvent milStatus → lamps.malfunction on j1939 events too',
    confirm:
      'whether milStatus on a j1939 event is the J1939 malfunction lamp (the spec defines it on every event: "the MIL status of the vehicle at the time"); an event without `fmi` is skipped and a sourceAddress over 255 (the spec\'s own example: 256) dropped',
    file: 'src/connectors/terminal/mapper.ts',
    basis: 'doc',
  },
  {
    source: 'terminal',
    what: 'paging and filters: `next` followed as `cursor` (no `limit` sent), ≤ 50 vehicleIds a call, modifiedAfter strictly after (the first faults run looks back 24 h)',
    confirm:
      'default and maximum `limit` per endpoint (the spec names none; "rely on the presence of next"); whether modifiedAfter is inclusive',
    file: 'src/connectors/terminal/client.ts',
    basis: 'spec',
  },
  {
    source: 'terminal',
    what: 'GET /vehicles?expand=groups: the provider group names offered to VEHICLE_KIND_TAGS (Terminal vehicles have no tags)',
    confirm:
      "whether haulers' provider groups ever say Semi or Pickup (else the kind comes from /admin/vehicles only)",
    file: 'src/connectors/terminal/mapper.ts (mapTerminalVehicle)',
    basis: 'doc',
  },
  {
    source: 'terminal',
    what: 'a connection Terminal refuses (403 forbidden, 410 connection_deleted, 422 connection_disconnected / invalid_credentials) is skipped, logged and rediscovered next run',
    confirm:
      'the status a rotated Connection-Token answers (401 or 403), and that a reconnect keeps the token (Terminal: "kept across reconnects")',
    file: 'src/connectors/terminal/client.ts (perConnection)',
    basis: 'spec',
  },
];
