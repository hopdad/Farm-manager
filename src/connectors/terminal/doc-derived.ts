/**
 * The terminal-pickups builder's unconfirmed Terminal shapes (1f.2, docs/contracts-1f.md part B).
 * Checked against Terminal's OpenAPI 3.1 (api.withterminal.com/tsp/openapi) and
 * docs.withterminal.com on Oct 30, 2026: both hosts, Bearer + Connection-Token, GET /connections
 * (each row carries its token), /providers (no key), the list shape `{ results, next? }`, the
 * flat error body, fractional Retry-After, metric units, the fault events' protocols and states
 * are spec-confirmed. Appended to the admin list by src/connectors/doc-derived.ts; the builder
 * adds its entries.
 */
import type { DocDerivedItem } from '../doc-derived';

export const TERMINAL_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'terminal',
    what: "history, stats and fault events (Terminal's own sync: /vehicles/{id}/locations, /stats/historical, /fault-codes/events)",
    confirm:
      "Terminal's sync cadence (how stale they get; it advises re-querying a 24-48 h lookback), whether engine_runtime is a cumulative meter (the spec's example isn't), what fault status `pending` means, which providers never send `closed`",
    file: 'src/connectors/terminal',
    basis: 'doc',
  },
  {
    source: 'terminal',
    what: 'sandbox access and which providers our haulers use',
    confirm:
      'sandbox is for Terminal customers only (a sales call); the providers behind real connections decide the capability rows (/providers); default and maximum `limit` per endpoint',
    file: 'src/connectors/endpoints.ts (terminalEndpoint)',
    basis: 'doc',
  },
];
