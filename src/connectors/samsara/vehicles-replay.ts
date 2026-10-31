/**
 * Samsara vehicle-list replay fixtures (slice 1f.2; owner: terminal-pickups,
 * docs/contracts-1f.md §B.6): its doc-derived fixtures for `fleet.vehicles` (GET /fleet/vehicles
 * with tags) live under ./fixtures/doc-derived/vehicles/, built by its own `vehicles-*.ts`
 * builder and listed here. Already appended to `samsaraReplayFixtures` (./replay.ts), so
 * CONNECTOR_SAMSARA=replay serves them.
 */
import type { ReplayFixture } from '../replay';

export const samsaraVehiclesReplayFixtures: readonly ReplayFixture[] = [];
