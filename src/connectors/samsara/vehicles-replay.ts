/**
 * Samsara vehicle-list replay fixtures (slice 1f.2; terminal-pickups, docs/contracts-1f.md §B.6):
 * the doc-derived fixture for `fleet.vehicles` (GET /fleet/vehicles with tags and gateways),
 * built by ./vehicles-fixtures.ts from Samsara's OpenAPI and the simulated farm. Already appended
 * to `samsaraReplayFixtures` (./replay.ts), so CONNECTOR_SAMSARA=replay serves it. Imported
 * statically so the JSON ships in the build.
 */
import type { ReplayFixture } from '../replay';
import vehicles from './fixtures/doc-derived/vehicles/01-vehicles.json';

export const samsaraVehiclesReplayFixtures: readonly ReplayFixture[] = [
  vehicles,
] as unknown as ReplayFixture[];
