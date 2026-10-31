/**
 * Motive replay fixtures (slice 1f.2; the trucks builder, docs/contracts-1f.md §B.6): the
 * doc-derived fixtures `CONNECTOR_MOTIVE=replay` serves (src/connectors/endpoints.ts
 * `replayFetch('motive')`), in match order: built by ./fixtures/build.ts from the demo world
 * (seed 1) with the shapes of Motive's OpenAPI 3.1, checked by ./fixtures/fixtures.test.ts.
 * Imported statically so the JSON ships in the build; the client loads this module only in
 * replay mode. Recorded fixtures never go in this list (§8).
 */
import type { ReplayFixture } from '../replay';
import companies from './fixtures/doc-derived/companies/01-companies.json';
import faults from './fixtures/doc-derived/faults/01-fault-codes.json';
import positions from './fixtures/doc-derived/positions/01-vehicle-locations.json';
import vehicles from './fixtures/doc-derived/vehicles/01-vehicles.json';

export const motiveReplayFixtures: readonly ReplayFixture[] = [
  companies,
  positions,
  faults,
  vehicles,
] as unknown as ReplayFixture[];
