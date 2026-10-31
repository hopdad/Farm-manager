/**
 * Terminal replay fixtures (slice 1f.2; the terminal-pickups builder, docs/contracts-1f.md part B
 * §B.6): the doc-derived fixtures `CONNECTOR_TERMINAL=replay` serves (src/connectors/endpoints.ts
 * `replayFetch('terminal')`), in match order, built by ./fixtures/build.ts from Terminal's OpenAPI
 * and the simulated farm (the hired hauler H3). Imported statically so the JSON ships in the
 * build; the client loads this module only in replay mode. Recorded fixtures never go in this
 * list (§8).
 */
import type { ReplayFixture } from '../replay';
import connections from './fixtures/doc-derived/connections/01-connections.json';
import faults from './fixtures/doc-derived/faults/01-fault-code-events.json';
import positions from './fixtures/doc-derived/positions/01-locations.json';
import providers from './fixtures/doc-derived/providers/01-providers.json';
import stats from './fixtures/doc-derived/stats/01-stats-historical.json';
import vehicles from './fixtures/doc-derived/vehicles/01-vehicles.json';

export const terminalReplayFixtures: readonly ReplayFixture[] = [
  connections,
  providers,
  vehicles,
  positions,
  stats,
  faults,
] as unknown as ReplayFixture[];
