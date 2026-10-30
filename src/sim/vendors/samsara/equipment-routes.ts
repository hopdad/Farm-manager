/**
 * Samsara equipment feeds in the stand-in (slice 1f.2; owner: the machines builder,
 * docs/contracts-1f.md part B): GET /fleet/equipment/locations/feed and
 * /fleet/equipment/stats/feed (gps, fuelPercents, gatewayJ1939EngineSeconds, synthetic engine
 * seconds) for the machines on Samsara asset gateways
 * (`simTelematicsMachines(farm, 'samsara', { feed: 'equipment' })`: the demo's RoGator).
 *
 * Foundation stub: answers nothing yet (the router replies 404 "not simulated").
 */
import type { SamsaraRouteModule } from './modules';

export const samsaraEquipmentModule: SamsaraRouteModule = {
  key: 'equipment',
  route: () => null,
};
