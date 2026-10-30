/**
 * Samsara vehicle metadata in the stand-in (slice 1f.2; owner: the terminal-pickups builder,
 * docs/contracts-1f.md part B): GET /fleet/vehicles with each vehicle's tags (`telematics.tags`:
 * 'Pickup', 'Semi'), so the vehicle-kind sync can set farm.machines.kind from a vendor tag.
 *
 * Foundation stub: answers nothing yet (the router replies 404 "not simulated").
 */
import type { SamsaraRouteModule } from './modules';

export const samsaraVehiclesModule: SamsaraRouteModule = {
  key: 'vehicles',
  route: () => null,
};
