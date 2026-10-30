/**
 * Samsara stand-in route modules (slice 1f.2, docs/contracts-1f.md part B §B.7): each 1f.2
 * builder answers its own Samsara paths in its own file, so nobody edits ./routes.ts (the
 * fleet-faults builder's in 1f). The router asks the modules in this order first (after the
 * token checks); the first non-null reply wins; then the core feeds.
 *
 *   equipment  ./equipment-routes.ts  machines builder: /fleet/equipment/locations/feed,
 *                                     /fleet/equipment/stats/feed (asset gateways: the RoGator)
 *   vehicles   ./vehicles-routes.ts   terminal-pickups: GET /fleet/vehicles (tags, for the
 *                                     vehicle kind) and anything else about vehicle metadata
 *
 * Both are created empty by the foundation (they answer null: 404 "not simulated").
 */
import type { VendorContext } from '../context';
import type { SimRequest, SimResponse } from '../http';
import { samsaraEquipmentModule } from './equipment-routes';
import { samsaraVehiclesModule } from './vehicles-routes';

export interface SamsaraRouteModule {
  key: 'equipment' | 'vehicles';
  /** Answer only your own paths; null = not mine. */
  route(req: SimRequest, ctx: VendorContext): SimResponse | null;
}

export const SAMSARA_ROUTE_MODULES: readonly SamsaraRouteModule[] = [
  samsaraEquipmentModule,
  samsaraVehiclesModule,
];
