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
      'which stats a carmaker-sourced pickup fills (engine hours, odometer, faultCodes), its GPS cadence, how the vehicle record says it is carmaker-sourced (the via), Ford eligibility (MY2020+, keyed on in the last 7 days) and the US Stellantis status',
    file: 'src/connectors/vendors.ts, src/sim/vendors/samsara/routes.ts',
  },
];
