/**
 * Deere stand-in route module `ops` (1f, owner: deere-ops; docs/contracts-1f.md §7): field
 * operations with measurements and coverage, from the demo world's day reports (`ctx.days`: a
 * finished field emits an operation). Created empty by the foundation: it serves nothing yet.
 */
import type { DeereRouteModule } from './modules';

export const deereOpsRoutes: DeereRouteModule = {
  key: 'ops',
  route: () => null,
};
