/**
 * MyGeotab replay fixtures (slice 1f.2; the trucks builder, docs/contracts-1f.md §B.6): the
 * doc-derived fixtures `CONNECTOR_GEOTAB=replay` serves (src/connectors/endpoints.ts
 * `replayFetch('geotab')`), in match order: built by ./fixtures/build.ts from the demo world
 * (seed 1) with the shapes of my.geotab.com/api.json, checked by ./fixtures/fixtures.test.ts.
 * Every JSON-RPC call posts to /apiv1, so exchanges are told apart by `request.body` (§8).
 * Imported statically so the JSON ships in the build; the client loads this module only in
 * replay mode. Recorded fixtures never go in this list (§8).
 */
import type { ReplayFixture } from '../replay';
import faults from './fixtures/doc-derived/faults/01-fault-data.json';
import lookups from './fixtures/doc-derived/lookups/01-diagnostics.json';
import positions from './fixtures/doc-derived/positions/01-log-records.json';
import stats from './fixtures/doc-derived/stats/01-status-data.json';
import vehicles from './fixtures/doc-derived/vehicles/01-devices.json';

export const geotabReplayFixtures: readonly ReplayFixture[] = [
  positions,
  stats,
  faults,
  lookups,
  vehicles,
] as unknown as ReplayFixture[];
