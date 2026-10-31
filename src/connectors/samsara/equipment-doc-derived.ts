/**
 * The machines builder's unconfirmed Samsara equipment shapes (1f.2, docs/contracts-1f.md part B).
 * Spec-confirmed (Samsara's OpenAPI, Oct 30, 2026): /fleet/equipment/locations|stats/feed, at
 * most 4 stat types per call, obdEngineSeconds (ECU), gatewayEngineSeconds (synthetic),
 * gatewayJ1939EngineSeconds (a manual offset), the engine states, gpsOdometerMeters, 10 req/s
 * (stats) and 5 req/s (locations) per the rate-limit page. Appended to the admin list by
 * src/connectors/doc-derived.ts; the builder adds its entries.
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
];
