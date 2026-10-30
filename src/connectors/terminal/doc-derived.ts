/**
 * The terminal-pickups builder's unconfirmed Terminal shapes (1f.2, docs/contracts-1f.md part B).
 * Paths, the Connection-Token header and the sandbox base came from the CLI generated from
 * Terminal's OpenAPI spec (confirmed); the live host and webhooks did not. Appended to the admin
 * list by src/connectors/doc-derived.ts; the builder adds its entries.
 */
import type { DocDerivedItem } from '../doc-derived';

export const TERMINAL_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'terminal',
    what: 'TERMINAL_API_BASE live default https://api.withterminal.com/tsp/v1 (sandbox https://api.sandbox.withterminal.com/tsp/v1 is confirmed)',
    confirm: 'the production host, rate limits, webhooks, which providers our haulers use',
    file: 'src/connectors/endpoints.ts (terminalEndpoint)',
  },
];
