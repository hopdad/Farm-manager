/**
 * The machines builder's unconfirmed Samsara equipment shapes (1f.2, docs/contracts-1f.md part B).
 * Spec-confirmed (Samsara's OpenAPI, Oct 30, 2026): /fleet/equipment/locations|stats/feed, at
 * most 4 stat types per call, obdEngineSeconds (ECU), gatewayEngineSeconds (synthetic),
 * gatewayJ1939EngineSeconds (a manual offset), the engine states, gpsOdometerMeters, 10 req/s
 * (stats) and 5 req/s (locations) per the rate-limit page. Appended to the admin list by
 * src/connectors/doc-derived.ts. The machines builder's client (./equipment-client.ts,
 * ./equipment-mapper.ts) added the entries after the first.
 */
import type { DocDerivedItem } from '../doc-derived';

export const SAMSARA_EQUIPMENT_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'samsara',
    what: 'equipment engine hours on an AG26 harness (obdEngineSeconds vs gatewayJ1939EngineSeconds)',
    confirm:
      "whether a tractor's diagnostic port gives obdEngineSeconds on the AG26 harness, and whether the J1939 count needs the manual offset first (Samsara's KB is blocked from the build machine); equipment faults through /readings/history (faultCodesJ1939, entityType=asset)",
    file: 'src/connectors/samsara/equipment*.ts',
    basis: 'doc',
  },
  {
    source: 'samsara',
    what: 'GET /fleet/equipment/locations/feed and /fleet/equipment/stats/feed (two calls of 4 and 3 types, each with its own cursor)',
    confirm:
      "one recorded page of each from a token with Read Equipment Statistics (the paths, the 4-type limit, the value shapes and the cursor rules are Samsara's spec)",
    file: 'src/connectors/samsara/equipment-client.ts',
    basis: 'spec',
  },
  {
    source: 'samsara',
    what: 'equipment engine state from obdEngineStates (Idle counts as running) before gatewayEngineStates; gatewayEngineSeconds preferred over gatewayJ1939EngineSeconds',
    confirm:
      "Samsara's field descriptions of the two gateway counts are swapped against the parameter text (vendor-docs samsara.md §4): confirm which is which on a recording",
    file: 'src/connectors/samsara/equipment-mapper.ts',
    basis: 'doc',
  },
];
