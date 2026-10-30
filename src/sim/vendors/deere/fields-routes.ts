/**
 * Deere stand-in route module `fields` (1f, owner: deere-data; docs/contracts-1f.md §7): farms,
 * fields, boundaries, flags, equipment and engine hours, computed from the simulated farm (ids
 * consistent with the demo seed's external refs, so sim mode matches the seeded fields instead of
 * duplicating them). Created empty by the foundation: it serves nothing yet (those paths answer
 * 404 "not simulated").
 */
import type { DeereRouteModule } from './modules';

export const deereFieldsRoutes: DeereRouteModule = {
  key: 'fields',
  route: () => null,
};
