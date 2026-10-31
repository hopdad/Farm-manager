/**
 * The terminal-pickups builder's unconfirmed pickup routes (1f.2, docs/contracts-1f.md part B):
 * Ford and Ram pickups through the telematics vendor's carmaker-cloud integrations (Samsara reads
 * Ford Pro and Stellantis Mobilisights). Appended to the admin list by
 * src/connectors/doc-derived.ts; the builder adds its entries (vehicle tags, the via field).
 */
import type { DocDerivedItem } from '../doc-derived';

export const VEHICLES_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'samsara',
    what: 'Ford Pro and Stellantis vehicles on the same /fleet/vehicles feeds (src/connectors/vendors.ts ford_pro, stellantis)',
    confirm:
      "which stats a carmaker-sourced pickup fills (engine hours, odometer, faultCodes: Samsara's API docs are silent and its KB how-tos are blocked; Stellantis sends no engine hours through Motive or Geotab), its GPS cadence, how the vehicle record says it is carmaker-sourced (the via: no gateway, make), Ford eligibility (MY2020+) and the US Stellantis status",
    file: 'src/connectors/vendors.ts, src/sim/vendors/samsara/routes.ts',
    basis: 'doc',
  },
];
