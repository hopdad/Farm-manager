/**
 * The terminal-pickups builder's pickup-route assumptions (1f.2, docs/contracts-1f.md part B
 * §B.5): Ford and Ram pickups through the telematics vendor's carmaker-cloud integrations
 * (Samsara reads Ford Pro and Stellantis Mobilisights), and the vehicle kind from vendor tags.
 * `spec` = from the vendor's own spec or docs, only a recorded response is missing; `doc` =
 * still unconfirmed. Appended to the admin list by src/connectors/doc-derived.ts.
 */
import type { DocDerivedItem } from '../doc-derived';

export const VEHICLES_DOC_DERIVED: readonly DocDerivedItem[] = [
  {
    source: 'samsara',
    what: 'Ford Pro and Stellantis vehicles on the same /fleet/vehicles feeds (src/connectors/vendors.ts ford_pro, stellantis)',
    confirm:
      "which stats a carmaker-sourced pickup fills (engine hours, odometer, faultCodes: Samsara's API docs are silent and its KB how-tos are blocked; Stellantis sends no engine hours through Motive or Geotab), its GPS cadence, Ford eligibility (MY2020+) and the US Stellantis status",
    file: 'src/connectors/vendors.ts, src/sim/vendors/samsara/routes.ts',
    basis: 'doc',
  },
  {
    source: 'samsara',
    what: 'telematics_via inferred from GET /fleet/vehicles: no Samsara `gateway` + make Ford → ford_pro, Ram / Dodge / Chrysler / Jeep → stellantis; an AG* gateway → gateway; a VG* gateway on a vehicle tagged a pickup → obd_device',
    confirm:
      "on a recording of the farm's org: that a carmaker-cloud vehicle really has no `gateway` and its maker's `make` (Samsara documents no carmaker flag; GET /readings/latest?hasGateway=false lists assets with no gateway)",
    file: 'src/connectors/samsara/vehicles-mapper.ts (samsaraVehicleVia)',
    basis: 'doc',
  },
  {
    source: 'samsara',
    what: 'the vehicle kind from tag names (GET /fleet/vehicles `tags[].name`, VEHICLE_KIND_TAGS: Semi, Pickup, Service truck by default)',
    confirm:
      'tags are customer-defined: the farm has to tag its pickups and service trucks in Samsara (or set the kind on /admin/vehicles, which always wins); limit 512 and endCursor paging are from the spec',
    file: 'src/connectors/samsara/vehicles-client.ts, src/connectors/samsara/vehicles-mapper.ts',
    basis: 'spec',
  },
];
