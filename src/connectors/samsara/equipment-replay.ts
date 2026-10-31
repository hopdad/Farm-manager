/**
 * Samsara equipment-feed replay fixtures (slice 1f.2; owner: the machines builder,
 * docs/contracts-1f.md §B.6): its doc-derived fixtures for `fleet.equipment` live under
 * ./fixtures/doc-derived/equipment_positions/ and ./fixtures/doc-derived/equipment_stats/, built
 * by ./equipment-fixtures.ts and listed here. Already appended to `samsaraReplayFixtures`
 * (./replay.ts), so CONNECTOR_SAMSARA=replay serves them.
 */

import type { ReplayFixture } from '../replay';
import positions from './fixtures/doc-derived/equipment_positions/01-equipment-locations-feed.json';
import stats from './fixtures/doc-derived/equipment_stats/01-equipment-stats-feed.json';

export const samsaraEquipmentReplayFixtures: readonly ReplayFixture[] = [
  positions,
  stats,
] as unknown as ReplayFixture[];
