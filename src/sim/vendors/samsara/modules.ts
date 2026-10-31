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
 *
 * Knobs: a module's `control()` is served at `/_control/vendor/samsara/<key>/...` (req.path is
 * the part after `/<key>`), behind the stand-in's loopback/Origin/JSON guard; a module keeps its
 * state in `ctx.state.vendors['samsara.<key>']` (`samsaraModuleState`) and calls
 * `ctx.persist()` after a change (reset clears it). fleet-faults' own knob
 * (`/_control/vendor/samsara/fault-codes`) is the core's, in ./routes.ts.
 */
import type { VendorContext, VendorControlContext } from '../context';
import type { SimRequest, SimResponse } from '../http';
import { samsaraEquipmentModule } from './equipment-routes';
import { samsaraVehiclesModule } from './vehicles-routes';

export type SamsaraModuleKey = 'equipment' | 'vehicles';

export interface SamsaraRouteModule {
  key: SamsaraModuleKey;
  /** Answer only your own paths; null = not mine. */
  route(req: SimRequest, ctx: VendorContext): SimResponse | null | Promise<SimResponse | null>;
  /** This module's knobs: `/_control/vendor/samsara/<key>/...`; null = unknown path (404). */
  control?(
    req: SimRequest,
    ctx: VendorControlContext,
  ): SimResponse | null | Promise<SimResponse | null>;
}

export const SAMSARA_ROUTE_MODULES: readonly SamsaraRouteModule[] = [
  samsaraEquipmentModule,
  samsaraVehiclesModule,
];

/** The persisted knob bag of module `key` (created on first use; call ctx.persist() after a change). */
export function samsaraModuleState(
  ctx: { state: { vendors?: Record<string, Record<string, unknown>> } },
  key: SamsaraModuleKey,
): Record<string, unknown> {
  ctx.state.vendors ??= {};
  const bag = `samsara.${key}`;
  ctx.state.vendors[bag] ??= {};
  return ctx.state.vendors[bag];
}
