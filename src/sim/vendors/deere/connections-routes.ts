/**
 * Deere stand-in route module `connections` (1f, owner: sync-health; docs/contracts-1f.md §7):
 * org approval for decision 5. To build: a knob (`/_control/vendor/deere/connections/...`) that
 * marks an org "needs approval"; such an org then carries a `connections` link in
 * GET /organizations (`orgLinks`) and answers 403 to every org-scoped call (`route`, which runs
 * before the other modules and the core). Created empty by the foundation: it serves nothing yet.
 */
import type { DeereRouteModule } from './modules';

export const deereConnectionsRoutes: DeereRouteModule = {
  key: 'connections',
  route: () => null,
};
